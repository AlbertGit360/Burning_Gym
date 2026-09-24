/**
 * Procedural FriendSDK cues. No recordings, downloads, music loop or game state.
 * The rounded tone and soft-tick formulas adapt the latest local Stats trailer
 * (2026-09-17), retaining the Make Friends trailer's earlier mint/pickup motifs.
 * Exact source hashes and adaptation notes live in sound-provenance.json.
 */

export const FRIEND_SOUND_IDS = ["select", "purchase", "action-start", "action-ready", "anticipation", "impact", "reveal-common", "reveal-rare", "reveal-legendary", "reward"] as const;
export type FriendSoundCue = typeof FRIEND_SOUND_IDS[number];
export const FRIEND_SOUND_SAMPLE_RATE = 48_000;
export const FRIEND_SOUND_MAX_VOICES = 4;
export const FRIEND_SOUND_MAX_GAIN = 0.3;
export const FRIEND_SOUND_PEAK = 0.7;

type Tone = Readonly<{ kind: "tone"; at: number; midi: number; duration: number; level: number;
  endMidi?: number; chip?: number; decay?: number; attack?: number; release?: number }>;
type Tick = Readonly<{ kind: "tick"; at: number; level: number; clap?: boolean }>;
type Voice = Tone | Tick;
type CueDefinition = Readonly<{ label: string; duration: number; motif: string; voices: readonly Voice[] }>;
const tone = (midi: number, duration: number, level: number, at = 0, options: Partial<Omit<Tone, "kind" | "midi" | "duration" | "level" | "at">> = {}): Tone =>
  ({ kind: "tone", at, midi, duration, level, ...options });
const tick = (at: number, level: number, clap = false): Tick => ({ kind: "tick", at, level, clap });
const sparkle = (notes: readonly number[], at = 0, level = 0.25): Tone[] => notes.map((midi, index) =>
  tone(midi, [0.09, 0.11, 0.22][index], level * [1, 0.85, 0.7][index], at + [0, 0.055, 0.12][index], { attack: 0.005, release: 0.027, chip: 0.18 }));

const definitions: Readonly<Record<FriendSoundCue, CueDefinition>> = {
  select: { label: "Select", duration: 0.1, motif: "A short rounded chip pluck", voices: [tone(67, 0.08, 0.22, 0, { attack: 0.003, release: 0.02 })] },
  "purchase": { label: "Purchase", duration: 0.36, motif: "The earlier mint-confirm C-major triplet", voices: [
    tone(48, 0.18, 0.1, 0, { chip: 0.12 }),
    ...[60, 64, 67].map((midi, index) => tone(midi, [0.1, 0.11, 0.21][index], 0.26 * [1, 0.86, 0.68][index], [0, 0.065, 0.135][index], { decay: 0.65, attack: 0.005, release: 0.028, chip: 0.19 })),
  ] },
  "action-start": { label: "Action start", duration: 0.25, motif: "The mint's rounded octave rise with a soft release tick", voices: [tone(48, 0.21, 0.23, 0, { endMidi: 60, decay: 1, chip: 0.16 }), tick(0.025, 0.09)] },
  "action-ready": { label: "Action ready", duration: 0.27, motif: "Two bright pickup notes", voices: [tone(76, 0.085, 0.24, 0, { attack: 0.004, release: 0.025, chip: 0.18 }), tone(79, 0.12, 0.25, 0.115, { attack: 0.004, release: 0.03, chip: 0.18 })] },
  "anticipation": { label: "Anticipation", duration: 0.3, motif: "Three climbing plucks and soft mechanical ticks", voices: [...sparkle([60, 64, 67]).map(voice => ({ ...voice, duration: Math.min(voice.duration, 0.14) })), tick(0, 0.08), tick(0.055, 0.07), tick(0.12, 0.06)] },
  "impact": { label: "Impact", duration: 0.23, motif: "A rounded falling tone with the trailer's filtered soft percussion", voices: [tone(57, 0.17, 0.14, 0, { endMidi: 40, chip: 0.12, decay: 0.55 }), tick(0, 0.25, true), tick(0.035, 0.13, true), tick(0.075, 0.08, true)] },
  "reveal-common": { label: "Common reward", duration: 0.38, motif: "A warm landing and compact C-major sparkle", voices: [tone(48, 0.24, 0.17, 0, { chip: 0.12, decay: 0.65 }), ...sparkle([60, 64, 67])] },
  "reveal-rare": { label: "Rare reward", duration: 0.58, motif: "The latest stat-transition G–C–E sparkle with a held top note", voices: [tone(43, 0.24, 0.15, 0, { chip: 0.12, decay: 0.65 }), ...sparkle([67, 72, 76]), tone(76, 0.37, 0.09, 0.18, { chip: 0.1, decay: 1.2, release: 0.1 })] },
  "reveal-legendary": { label: "Legendary reward", duration: 1.05, motif: "A mint rise, high pickup sparkle and warm final C-major resolution", voices: [tone(48, 0.18, 0.12, 0, { endMidi: 60, chip: 0.16 }), ...sparkle([72, 76, 79], 0.13, 0.27),
    ...[36, 60, 64, 67].map((midi, index) => tone(midi, 0.65, [0.19, 0.14, 0.1, 0.08][index], 0.37, { decay: 1.4, attack: 0.016, release: 0.2, chip: 0.1 })),
  ] },
  reward: { label: "Reward", duration: 0.36, motif: "The latest world-token-pickup C–E–G sparkle", voices: sparkle([72, 76, 79]) },
};

export const FRIEND_SOUND_CUES: Readonly<Record<FriendSoundCue, Readonly<{ label: string; duration: number; motif: string }>>> = Object.freeze(
  Object.fromEntries(FRIEND_SOUND_IDS.map(id => { const { label, duration, motif } = definitions[id]; return [id, Object.freeze({ label, duration, motif })]; })) as Record<FriendSoundCue, { label: string; duration: number; motif: string }>,
);

function cueDefinition(cue: FriendSoundCue): CueDefinition {
  if (!FRIEND_SOUND_IDS.includes(cue)) throw new TypeError(`Unknown Friend sound: ${String(cue)}`);
  return definitions[cue];
}
function unit(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
}
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const triangle = (phase: number) => 4 * Math.abs(phase % 1 - 0.5) - 1;
const smooth = (amount: number) => Math.sin(Math.PI / 2 * Math.min(1, Math.max(0, amount))) ** 2;

/** Pure mono PCM, suitable for AudioBuffer or a 16-bit WAV encoder. Always deterministic; never accesses browser APIs. */
export function renderFriendSound(cue: FriendSoundCue, options: { sampleRate?: number } = {}): Float32Array {
  const definition = cueDefinition(cue);
  const sampleRate = options.sampleRate ?? FRIEND_SOUND_SAMPLE_RATE;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError("sampleRate must be an integer between 8000 and 192000");
  const output = new Float64Array(Math.round(definition.duration * sampleRate));
  let randomState = 0x52465354 ^ (FRIEND_SOUND_IDS.indexOf(cue) + 1);
  const noise = () => {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x100000000 * 2 - 1;
  };
  for (const voice of definition.voices) {
    const duration = voice.kind === "tone" ? voice.duration : voice.clap ? 0.105 : 0.037;
    const count = Math.round(duration * sampleRate), start = Math.round(voice.at * sampleRate);
    let phase = 0, filtered = 0;
    for (let index = 0; index < count && start + index < output.length; index++) {
      const t = index / sampleRate, remaining = (count - 1 - index) / sampleRate;
      let sample: number;
      if (voice.kind === "tone") {
        const frequency = hz(voice.midi), end = hz(voice.endMidi ?? voice.midi);
        phase += frequency * (end / frequency) ** (t / duration) / sampleRate;
        const envelope = smooth(t / (voice.attack ?? 0.009)) * smooth(remaining / (voice.release ?? 0.045)) * Math.exp(-t / (duration * (voice.decay ?? 0.78)));
        const chip = voice.chip ?? 0.24;
        sample = voice.level * envelope * ((1 - chip) * Math.sin(2 * Math.PI * phase) + chip * triangle(phase + 0.75));
      } else {
        // Match the trailer's 48 kHz one-pole response at other export rates.
        filtered += (1 - (1 - 0.17) ** (48000 / sampleRate)) * (noise() - filtered);
        const envelope = Math.min(1, t / 0.001) * Math.exp(-t / (voice.clap ? 0.021 : 0.007)) * Math.min(1, remaining / 0.009);
        sample = voice.level * envelope * (0.8 * filtered + 0.2 * Math.sin(2 * Math.PI * (voice.clap ? 210 : 740) * t));
      }
      output[start + index] += sample;
    }
  }
  let peak = 0;
  for (const sample of output) peak = Math.max(peak, Math.abs(sample));
  const gain = peak ? FRIEND_SOUND_PEAK / peak : 0;
  return Float32Array.from(output, sample => sample * gain);
}

export type FriendSoundState = Readonly<{ status: "locked" | "ready" | "unsupported" | "disposed"; muted: boolean; volume: number; activeVoices: number }>;
export type FriendSoundKit = Readonly<{
  readonly state: FriendSoundState;
  /** Call directly within a user gesture. No cue is queued during unlocking. */
  unlock(): Promise<boolean>;
  /** Returns false while locked, muted, hidden, unavailable or disposed. */
  play(cue: FriendSoundCue, options?: { volume?: number; delay?: number }): boolean;
  stop(): void;
  dispose(): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
}>;

/**
 * Lazy Web Audio controller. Constructing this object is safe during SSR and
 * allocates no AudioContext. No pending unlock or delayed cue survives stop,
 * mute, document hiding or disposal. The oldest voice is stolen at four cues.
 */
export function createFriendSoundKit(options: { muted?: boolean; volume?: number } = {}): FriendSoundKit {
  if (options.muted !== undefined && typeof options.muted !== "boolean") throw new TypeError("muted must be a boolean");
  let muted = options.muted ?? false, volume = unit(options.volume ?? 0.65, "volume");
  let context: AudioContext | null = null, master: GainNode | null = null;
  let unlocked = false, unsupported = false, disposed = false, epoch = 0;
  let pending: Promise<boolean> | null = null, listening = false;
  const buffers = new Map<FriendSoundCue, AudioBuffer>();
  type Playing = { source: AudioBufferSourceNode; gain: GainNode; released: boolean };
  const voices = new Set<Playing>();
  const doc = typeof document === "undefined" ? null : document;
  const win = typeof window === "undefined" ? null : window;
  const hidden = () => Boolean(doc?.hidden);
  function release(voice: Playing) {
    if (voice.released) return;
    voice.released = true; voices.delete(voice); voice.source.onended = null;
    try { voice.source.disconnect(); } catch { /* Already detached. */ }
    try { voice.gain.disconnect(); } catch { /* Already detached. */ }
  }
  function halt(voice: Playing) {
    try { voice.source.stop(); } catch { /* A finished source can already be stopped. */ }
    release(voice);
  }
  function stop() {
    epoch++;
    if (pending) { pending = null; unlocked = false; }
    for (const voice of [...voices]) halt(voice);
  }
  const visibility = () => { if (hidden()) stop(); };
  const pageHide = () => stop();
  function masterLevel() { if (master) master.gain.value = muted ? 0 : volume * FRIEND_SOUND_MAX_GAIN; }
  function attach() {
    if (listening) return;
    doc?.addEventListener("visibilitychange", visibility); win?.addEventListener("pagehide", pageHide); listening = true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; unlocked = false; stop(); buffers.clear();
    if (listening) { doc?.removeEventListener("visibilitychange", visibility); win?.removeEventListener("pagehide", pageHide); listening = false; }
    try { master?.disconnect(); } catch { /* Closing a graph is idempotent. */ }
    const previous = context; context = null; master = null;
    if (previous) { try { void previous.close().catch(() => {}); } catch { /* Unsupported close. */ } }
  }
  function unlock(): Promise<boolean> {
    if (disposed || muted || hidden() || unsupported) return Promise.resolve(false);
    if (unlocked && context?.state === "running") return Promise.resolve(true);
    if (pending) return pending;
    if (context?.state === "closed") {
      for (const voice of [...voices]) halt(voice);
      try { master?.disconnect(); } catch { /* The browser closed this graph. */ }
      context = null; master = null; unlocked = false; buffers.clear();
    }
    const generation = epoch;
    if (!context || context.state === "closed") {
      try {
        const AudioContextClass = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) { unsupported = true; return Promise.resolve(false); }
        context = new AudioContextClass(); master = context.createGain(); masterLevel(); master.connect(context.destination); buffers.clear(); attach();
      } catch {
        const failed = context; context = null; master = null; unsupported = true;
        if (failed) { try { void failed.close().catch(() => {}); } catch { /* Allocation was rejected. */ } }
        return Promise.resolve(false);
      }
    }
    const active = context;
    let resume: Promise<void>;
    try { resume = active.state === "running" ? Promise.resolve() : active.resume(); }
    catch { unlocked = false; return Promise.resolve(false); }
    unlocked = false;
    const attempt = resume.then(() => {
      if (disposed || generation !== epoch || muted || hidden() || context !== active || active.state !== "running") return false;
      unlocked = true; return true;
    }, () => false).finally(() => { if (pending === attempt) pending = null; });
    pending = attempt;
    return attempt;
  }
  function play(cue: FriendSoundCue, playOptions: { volume?: number; delay?: number } = {}): boolean {
    cueDefinition(cue);
    const level = unit(playOptions.volume ?? 1, "cue volume"), delay = unit(playOptions.delay ?? 0, "delay");
    if (disposed || muted || hidden() || !unlocked || !context || !master || context.state !== "running" || !volume || !level) return false;
    let source: AudioBufferSourceNode | null = null, gain: GainNode | null = null, voice: Playing | null = null;
    try {
      let buffer = buffers.get(cue);
      if (!buffer) {
        const pcm = renderFriendSound(cue);
        buffer = context.createBuffer(1, pcm.length, FRIEND_SOUND_SAMPLE_RATE); buffer.getChannelData(0).set(pcm); buffers.set(cue, buffer);
      }
      if (voices.size >= FRIEND_SOUND_MAX_VOICES) halt(voices.values().next().value!);
      source = context.createBufferSource(); gain = context.createGain(); gain.gain.value = level;
      source.buffer = buffer; source.connect(gain); gain.connect(master);
      voice = { source, gain, released: false }; voices.add(voice);
      const playing = voice; source.onended = () => release(playing);
      source.start(context.currentTime + delay); return true;
    } catch {
      if (voice) halt(voice);
      else { try { source?.disconnect(); } catch {} try { gain?.disconnect(); } catch {} }
      return false;
    }
  }
  return Object.freeze({
    get state(): FriendSoundState { return Object.freeze({ status: disposed ? "disposed" : unsupported ? "unsupported" : unlocked && context?.state === "running" ? "ready" : "locked", muted, volume, activeVoices: voices.size }); },
    unlock, play, stop, dispose,
    setMuted(next: boolean) {
      if (typeof next !== "boolean") throw new TypeError("muted must be a boolean");
      if (disposed) return;
      muted = next; masterLevel(); if (muted) stop();
    },
    setVolume(next: number) { const checked = unit(next, "volume"); if (disposed) return; volume = checked; masterLevel(); if (!volume) stop(); },
  });
}
