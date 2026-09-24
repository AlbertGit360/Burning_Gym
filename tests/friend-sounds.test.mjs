import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { FRIEND_SOUND_IDS, FRIEND_SOUND_CUES, FRIEND_SOUND_SAMPLE_RATE, FRIEND_SOUND_PEAK, FRIEND_SOUND_MAX_GAIN,
  FRIEND_SOUND_MAX_VOICES, renderFriendSound, createFriendSoundKit } from '../dist/friend-sounds.js';

function metrics(pcm) {
  let peak = 0, squares = 0, total = 0;
  for (const value of pcm) { assert.ok(Number.isFinite(value)); peak = Math.max(peak, Math.abs(value)); squares += value * value; total += value; }
  return { peak, rms: Math.sqrt(squares / pcm.length), dc: total / pcm.length };
}

test('all ten original cues render deterministic non-silent PCM with bounded peaks and silent endpoints', () => {
  assert.equal(FRIEND_SOUND_IDS.length, 10);
  const hashes = new Set();
  for (const cue of FRIEND_SOUND_IDS) {
    for (const sampleRate of [8000, 44100, 48000, 96000]) {
      const pcm = renderFriendSound(cue, { sampleRate });
      assert.ok(pcm instanceof Float32Array);
      assert.equal(pcm.length, Math.round(FRIEND_SOUND_CUES[cue].duration * sampleRate));
      assert.deepEqual(renderFriendSound(cue, { sampleRate }), pcm);
      assert.equal(pcm[0], 0); assert.equal(pcm.at(-1), 0);
      const { peak, rms, dc } = metrics(pcm);
      assert.ok(peak > 0.69 && peak <= 0.700001, `${cue}: ${peak}`);
      assert.ok(rms > 0.02 && rms < 0.5, `${cue} has useful signal energy`);
      assert.ok(Math.abs(dc) < 0.025, `${cue} avoids a material DC offset`);
      if (sampleRate === 48000) hashes.add(createHash('sha256').update(new Uint8Array(pcm.buffer)).digest('hex'));
    }
  }
  assert.equal(hashes.size, FRIEND_SOUND_IDS.length, 'Every cue has distinct audio');
  assert.equal(FRIEND_SOUND_MAX_VOICES * FRIEND_SOUND_MAX_GAIN * FRIEND_SOUND_PEAK, 0.84);
  const original = renderFriendSound('select'); original.fill(1);
  assert.notEqual(renderFriendSound('select')[0], 1, 'Callers cannot poison a shared PCM cache');
});

test('rounded select timbre matches independently calculated Python source samples', () => {
  // Computed independently with the Stats trailer tone() formula, G4, 80 ms,
  // a 3 ms attack / 20 ms release and normalized mono peak 0.7.
  const reference = [[0, 0], [1, 0.000008198], [32, 0.083192386], [64, -0.052411907], [100, -0.474172675],
    [150, 0.686500261], [300, 0.15850736], [800, -0.13276051], [1500, 0.442667326], [2500, 0.134036114], [3500, -0.031727879], [3839, 0]];
  const pcm = renderFriendSound('select');
  for (const [index, expected] of reference) assert.ok(Math.abs(pcm[index] - expected) < 0.0000001, `Source sample ${index}`);
  assert.ok(FRIEND_SOUND_CUES['reveal-legendary'].duration > FRIEND_SOUND_CUES['reveal-rare'].duration);
  assert.ok(FRIEND_SOUND_CUES['reveal-rare'].duration > FRIEND_SOUND_CUES['reveal-common'].duration);
});

class TrackedEvents extends EventTarget {
  hidden = false;
  listeners = new Map();
  addEventListener(type, callback, options) { super.addEventListener(type, callback, options); const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set); }
  removeEventListener(type, callback, options) { super.removeEventListener(type, callback, options); this.listeners.get(type)?.delete(callback); }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
}
async function environment(run, options = {}) {
  const names = ['AudioContext', 'webkitAudioContext', 'document', 'window'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const doc = new TrackedEvents(), win = new TrackedEvents(), contexts = [];
  const flags = { ...options };
  class Context {
    state = 'suspended'; currentTime = 10; destination = {}; sources = []; gains = []; buffers = []; resumes = []; closeCalls = 0;
    constructor() { if (flags.constructorFailure) throw new Error('Unavailable'); contexts.push(this); }
    createGain() { if (flags.gainFailure) throw new Error('Graph rejected'); const node = { gain: { value: 1 }, connections: [], disconnected: 0, connect(to) { this.connections.push(to); }, disconnect() { this.disconnected++; } }; this.gains.push(node); return node; }
    createBuffer(channels, length, rate) { const data = new Float32Array(length); const buffer = { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data }; this.buffers.push(buffer); return buffer; }
    createBufferSource() { const source = { buffer: null, onended: null, started: [], stops: 0, disconnected: 0, connect() {}, disconnect() { this.disconnected++; },
      start(time) { if (flags.startFailure) throw new Error('Start rejected'); this.started.push(time); }, stop() { this.stops++; this.onended?.(); } }; this.sources.push(source); return source; }
    resume() { return new Promise((resolve, reject) => this.resumes.push({ resolve: () => { this.state = 'running'; resolve(); }, reject })); }
    close() { this.closeCalls++; this.state = 'closed'; return flags.closeFailure ? Promise.reject(new Error('Close rejected')) : Promise.resolve(); }
  }
  for (const [name, value] of Object.entries({ AudioContext: options.unsupported ? undefined : Context, webkitAudioContext: undefined, document: options.ssr ? undefined : doc, window: options.ssr ? undefined : win })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try { await run({ contexts, doc, win, flags }); }
  finally { for (const name of names) { if (previous[name]) Object.defineProperty(globalThis, name, previous[name]); else delete globalThis[name]; } }
}
async function enable(kit, contexts) { const ready = kit.unlock(); contexts.at(-1).resumes.at(-1)?.resolve(); assert.equal(await ready, true); return contexts.at(-1); }

test('SSR and unsupported browsers stay silent without allocations or thrown resume errors', async () => {
  await environment(async ({ contexts }) => {
    const kit = createFriendSoundKit(); assert.equal(contexts.length, 0); assert.equal(kit.state.status, 'locked');
    assert.equal(kit.play('select'), false); assert.equal(await kit.unlock(), false); assert.equal(kit.state.status, 'unsupported');
    kit.stop(); kit.setMuted(true); kit.dispose(); kit.dispose(); assert.equal(kit.state.status, 'disposed'); assert.equal(contexts.length, 0);
  }, { ssr: true, unsupported: true });
  for (const options of [{ constructorFailure: true }, { gainFailure: true, closeFailure: true }]) await environment(async () => {
    const kit = createFriendSoundKit(); assert.equal(await kit.unlock(), false); assert.equal(kit.play('purchase'), false); kit.dispose();
  }, options);
});

test('explicit unlock creates one context, never queues locked sounds and reuses decoded buffers', async () => {
  await environment(async ({ contexts, doc }) => {
    const kit = createFriendSoundKit({ volume: 0.5 }); assert.equal(contexts.length, 0); assert.equal(doc.count('visibilitychange'), 0);
    assert.equal(kit.play('select'), false);
    const ready = kit.unlock(); assert.equal(kit.unlock(), ready); const context = contexts[0];
    assert.equal(contexts.length, 1); assert.equal(context.resumes.length, 1); assert.equal(kit.play('purchase'), false); assert.equal(context.sources.length, 0);
    context.resumes[0].resolve(); assert.equal(await ready, true); assert.equal(context.sources.length, 0, 'Unlock does not replay earlier requests');
    assert.equal(context.gains[0].gain.value, 0.15);
    assert.equal(kit.play('select', { volume: 0.4, delay: 0.2 }), true);
    assert.deepEqual(context.sources[0].started, [10.2]); assert.equal(context.gains[1].gain.value, 0.4);
    assert.equal(context.buffers[0].sampleRate, FRIEND_SOUND_SAMPLE_RATE); assert.equal(context.buffers[0].numberOfChannels, 1);
    assert.equal(kit.play('select'), true); assert.equal(context.buffers.length, 1); assert.equal(kit.state.activeVoices, 2);
    context.sources[0].onended(); assert.equal(kit.state.activeVoices, 1); assert.equal(context.sources[0].disconnected, 1);
    kit.dispose(); assert.equal(context.closeCalls, 1); assert.equal(kit.state.activeVoices, 0); assert.equal(doc.count('visibilitychange'), 0);
  });
});

test('polyphony is bounded, delayed cues stop, and mute or zero volume cancels every voice', async () => {
  await environment(async ({ contexts }) => {
    const kit = createFriendSoundKit(); const context = await enable(kit, contexts);
    for (let index = 0; index < 10; index++) { assert.equal(kit.play('reveal-legendary', { delay: 1 }), true); assert.ok(kit.state.activeVoices <= 4); }
    assert.ok(context.sources.slice(0, 6).every(source => source.stops === 1));
    kit.stop(); kit.stop(); assert.equal(kit.state.activeVoices, 0); assert.ok(context.sources.every(source => source.stops === 1));
    assert.equal(kit.play('reward'), true); kit.setMuted(true); assert.equal(kit.state.activeVoices, 0); assert.equal(context.gains[0].gain.value, 0);
    assert.equal(kit.play('reward'), false); assert.equal(await kit.unlock(), false);
    kit.setMuted(false); assert.equal(kit.play('reward'), true); kit.setVolume(0); assert.equal(kit.state.activeVoices, 0); assert.equal(kit.play('reward'), false);
    kit.setVolume(1); assert.equal(context.gains[0].gain.value, 0.3); assert.equal(kit.play('reward'), true); kit.dispose();
  });
});

test('repeated gesture unlock keeps an enabled kit playable within the same event', async () => {
  await environment(async ({ contexts }) => {
    const kit = createFriendSoundKit(); const context = await enable(kit, contexts);
    for (let index = 0; index < 3; index++) {
      const ready = kit.unlock();
      assert.equal(kit.state.status, 'ready');
      assert.equal(kit.play('select'), true, 'A capture-phase unlock must not suppress the following handler');
      assert.equal(await ready, true);
    }
    assert.equal(contexts.length, 1); assert.equal(context.resumes.length, 1); assert.equal(context.sources.length, 3);
    kit.dispose();
  });
});

test('stop, mute, hide and disposal invalidate an unresolved unlock without stale playback', async () => {
  for (const intervention of ['stop', 'mute', 'hide', 'dispose']) await environment(async ({ contexts, doc }) => {
    const kit = createFriendSoundKit(); const pending = kit.unlock(); const context = contexts[0];
    if (intervention === 'hide') { doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); }
    else if (intervention === 'mute') kit.setMuted(true);
    else kit[intervention]();
    context.resumes[0].resolve(); assert.equal(await pending, false, intervention); assert.equal(kit.play('select'), false);
    assert.equal(context.sources.length, 0);
    if (intervention !== 'dispose') { doc.hidden = false; kit.setMuted(false); assert.equal(await kit.unlock(), true); assert.equal(kit.play('select'), true); }
    kit.dispose();
  });
});

test('a new gesture can unlock after cancellation while an older resume is still unresolved', async () => {
  await environment(async ({ contexts }) => {
    const kit = createFriendSoundKit(); const old = kit.unlock(); kit.stop(); const current = kit.unlock(); const context = contexts[0];
    assert.notEqual(old, current); assert.equal(context.resumes.length, 2);
    context.resumes[1].resolve(); assert.equal(await current, true);
    context.resumes[0].resolve(); assert.equal(await old, false);
    assert.equal(kit.state.status, 'ready'); assert.equal(kit.play('select'), true); kit.dispose();
  });
});

test('resume rejection permits a retry; visibility and pagehide stop sounds without replaying them', async () => {
  await environment(async ({ contexts, doc, win, flags }) => {
    const kit = createFriendSoundKit(); const first = kit.unlock(); const context = contexts[0];
    context.resumes[0].reject(new Error('Gesture rejected')); assert.equal(await first, false); assert.equal(kit.state.status, 'locked');
    await enable(kit, contexts); assert.equal(contexts.length, 1); assert.equal(doc.count('visibilitychange'), 1);
    kit.play('action-start'); doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(kit.state.activeVoices, 0); assert.equal(kit.play('action-ready'), false);
    const count = context.sources.length; doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); assert.equal(context.sources.length, count);
    kit.play('anticipation'); win.dispatchEvent(new Event('pagehide')); assert.equal(kit.state.activeVoices, 0);
    flags.startFailure = true; assert.equal(kit.play('impact'), false); assert.equal(kit.state.activeVoices, 0);
    flags.startFailure = false; kit.play('reward'); context.state = 'closed';
    const reopened = kit.unlock(); assert.equal(contexts.length, 2); contexts[1].resumes[0].resolve(); assert.equal(await reopened, true); assert.equal(kit.state.activeVoices, 0);
    assert.equal(kit.play('reward'), true); kit.dispose(); assert.equal(win.count('pagehide'), 0); assert.equal(await kit.unlock(), false);
  });
});

test('invalid control values are rejected without allocating audio or bypassing gain limits', async () => {
  for (const value of [NaN, Infinity, -1, 1.1, '1']) assert.throws(() => createFriendSoundKit({ volume: value }));
  assert.throws(() => createFriendSoundKit({ muted: 'yes' }));
  for (const rate of [0, 7999, 192001, 44100.5, Infinity, '48000']) assert.throws(() => renderFriendSound('select', { sampleRate: rate }));
  assert.throws(() => renderFriendSound('unknown'));
  await environment(async ({ contexts }) => {
    const kit = createFriendSoundKit({ muted: true }); assert.equal(await kit.unlock(), false); assert.equal(contexts.length, 0);
    assert.throws(() => kit.play('unknown')); assert.throws(() => kit.play('select', { volume: 2 })); assert.throws(() => kit.play('select', { delay: 2 }));
    assert.throws(() => kit.setMuted(1)); assert.throws(() => kit.setVolume(NaN)); kit.dispose();
  });
});

test('provenance records the two trailer sources and the runtime bundles without audio files or dependencies', async () => {
  const provenance = JSON.parse(await readFile(new URL('../assets/sound-provenance.json', import.meta.url), 'utf8'));
  assert.deepEqual(provenance.sources.map(source => source.date), ['2026-09-17', '2026-09-15']);
  for (const source of provenance.sources) { assert.match(source.renderer_sha256, /^[a-f0-9]{64}$/); assert.match(source.cue_manifest_sha256, /^[a-f0-9]{64}$/); }
  assert.equal(provenance.recordings_or_soundtrack_samples_embedded, false);
  assert.deepEqual(Object.keys(provenance.cue_sources), [...FRIEND_SOUND_IDS]);
  const bundled = await build({ entryPoints: ['src/friend-sounds.ts'], platform: 'browser', format: 'esm', bundle: true, minify: true, write: false, metafile: true });
  assert.deepEqual(Object.keys(bundled.metafile.inputs), ['src/friend-sounds.ts']);
  assert.ok(bundled.outputFiles[0].contents.length < 20_000);
  assert.doesNotMatch(bundled.outputFiles[0].text, /\bfetch\s*\(|Math\.random|\.mp3|\.wav|data:audio/);
});
