import assert from 'node:assert/strict';
import test from 'node:test';
import { loadImage, loadWorldAssets } from '../dist/assets.js';
import { getWorldPreset } from '../dist/friend-world.js';

test('image loading exposes success, failure and cancellation without stale callbacks', async () => {
  const original = globalThis.Image, created = [];
  globalThis.Image = class { constructor() { created.push(this); } };
  try {
    const loaded = loadImage('/approved/game.png');
    assert.equal(created[0].src, '/approved/game.png'); created[0].onload();
    assert.equal(await loaded, created[0]); assert.equal(created[0].onload, null);
    const failed = loadImage('/missing.png'); created[1].onerror();
    await assert.rejects(failed, /could not load/);
    const controller = new AbortController(), cancelled = loadImage('/slow.png', controller.signal);
    controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(created[2].src, ''); assert.equal(created[2].onload, null);
    await assert.rejects(loadImage('/never-started.png', controller.signal), { name: 'AbortError' });
    assert.equal(created.length, 3);
  } finally { if (original === undefined) delete globalThis.Image; else globalThis.Image = original; }
});

test('world loading preserves object positions and render order', async () => {
  const original = globalThis.Image;
  globalThis.Image = class { set src(value) { this.source = value; queueMicrotask(() => this.onload?.()); } };
  try {
    const world = getWorldPreset('01-garden-oval-complete');
    const assets = await loadWorldAssets(world, { signals: false });
    assert.equal(assets.objects.length, world.props.length);
    assert.deepEqual(assets.objects.map(object => object.depth), assets.objects.map(object => object.depth).sort((a, b) => a - b));
    assert.ok(assets.terrain.source.startsWith('data:image/svg+xml;'));
  } finally { if (original === undefined) delete globalThis.Image; else globalThis.Image = original; }
});
