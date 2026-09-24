import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import {
  CANVAS, GAME_PALETTE, PROJECTION, PROP_CANVAS, PROP_TYPES, WORLD_PRESETS,
  getWorldPreset, isWorldWalkable, project, propArtwork, renderProp, renderWorld,
  renderWorldLayers, sortWorldItems, unproject, validateWorld, worldContains,
} from '../dist/friend-world.js';

function square(overrides = {}) {
  return { id: 'test-world', name: 'Test world', family: 'test', setting: 'Garden', shape: 'Square',
    summary: 'A small test scene', variant: 'complete',
    geometry: { polygons: [[[0, 0], [288, 0], [288, 288], [0, 288]]], holes: [], depth: 18 },
    props: [], actors: [], paths: [], patches: [], signals: [], missingChunks: [], ...overrides };
}
const rows = Array.from({ length: 16 }, (_, row) => row === 0 ? '#...............' : row === 15 ? '...............#' : '................');

// These digests were measured from the independent canonical renderer.mjs with
// characters:false. Everything from <defs> onward must preserve the original art.
const canonicalArtHashes = [
  '27c81caa4dd9d46506f639bac4b239e52bc94d51052086a679a9631e7c891073',
  '2d939c90e029b879f9b607c5fabdf7cc4154bd532db43c4b2a0388bdbdf3fab2',
  '5374639bebb27611bd03581cb03e512d39487fd191005ad274ef69f06113cf62',
  '3c3e9eab8e1aa1ac9fddb948183ff9ab4381177caa940768ab0f0ddc7dc3e544',
  '73715acb9f5cc4c7b8e14aaf9e160763799a86ca754bd851f9254e4acd4bebf2',
  '19966d57ab05c972d03316a7046738e9f23b3b2d8cc91530a82569d176f06822',
  'cfc86dc161e238a8464d5e92bd25c19a7bd693d6b0a3cf75b37e320ad5e57232',
  'ef8729492f568579af873883b66fb327263c15c675ed632e9b4d9edc5f3cb744',
  '2df06d4aeda3a748c944e8fa86c324de9c93db89fec613398a39e2214b687350',
  '91d9ee3ada5b10ef25219a800807b525dfa640a015845693bb1d62f9426de718',
  '94855637e22369526a1ca6eb47b218cb0b7de60e4609284359215ed40690b4df',
  '238bb2251b51d33f06cfde913b337f67518db4a11df998a5fe45edf619062874',
];

test('all twelve complete/loading worlds preserve canonical vector artwork and never load snapshot actors', () => {
  assert.equal(WORLD_PRESETS.length, 12);
  assert.equal(new Set(WORLD_PRESETS.map(world => world.family)).size, 6);
  for (const [index, world] of WORLD_PRESETS.entries()) {
    const svg = renderWorld(world);
    const artwork = svg.slice(svg.indexOf('<defs>'));
    assert.equal(createHash('sha256').update(artwork).digest('hex'), canonicalArtHashes[index], world.id);
    assert.ok(!svg.includes('class="world-actors"'), 'Composition anchors never import an old character snapshot');
    assert.equal(world.variant, index % 2 ? 'loading' : 'complete');
    for (const item of [...world.actors, ...world.props, ...world.signals]) assert(worldContains(world, [item.x, item.y]));
  }
  const garden = getWorldPreset('01-garden-oval-complete');
  assert.equal(garden, WORLD_PRESETS[0]);
  assert.throws(() => { garden.props[0].x = 42; }, TypeError);
  assert.throws(() => getWorldPreset('not-a-world'), /Unknown world/);
  const editable = structuredClone(garden);
  editable.name = 'My garden';
  assert.equal(validateWorld(editable).name, 'My garden');
  assert.equal(garden.name, 'Garden Commons');
});

test('projection retains the canonical camera and can invert screen motion and lift', () => {
  assert.deepEqual(CANVAS, { width: 1600, height: 1200 });
  assert.deepEqual(PROJECTION, { a: 0.8660254038, b: 0.28, scale: 1.5, width: 576, height: 384, cx: 800, cy: 690 });
  assert.deepEqual(project(288, 192), [800, 690]);
  assert.deepEqual(project(0, 0), [675.292, 488.4]);
  assert.deepEqual(project(576, 384), [924.708, 891.6]);
  assert.deepEqual(project(120, 212, 24), [555.781, 603.84]);
  for (const [x, y] of [[0, 0], [576, 384], [120, 212], [288, 192]]) {
    for (const lift of [0, 32]) {
      const actual = unproject(...project(x, y, lift), lift);
      assert.ok(Math.abs(actual[0] - x) < 0.002 && Math.abs(actual[1] - y) < 0.002);
    }
  }
  for (const value of [NaN, Infinity, '24', null]) {
    assert.throws(() => project(value, 1), /finite number/);
    assert.throws(() => unproject(800, value), /finite number/);
  }
});

test('optional game colors preserve all world geometry, masks, depth order and canonical Friend pixels', () => {
  assert.deepEqual(GAME_PALETTE, { meadow: '#B9D984', pond: '#7DB4DB', sun: '#F2CE68', coral: '#ED927E', lilac: '#B3A0D8' });
  assert.ok(Object.isFrozen(GAME_PALETTE));
  const geometry = svg => svg.replace(/<defs>[\s\S]*?<\/defs>/, '').replace(/\s(?:fill|stroke)="[^"]*"/g, '');
  const allowed = new Set([...Object.values(GAME_PALETTE), '#000', '#fff']);
  for (const world of WORLD_PRESETS) {
    const mono = renderWorld(world), color = renderWorld(world, { color: true });
    assert.equal(renderWorld(world, { color: false }), mono);
    assert.equal(geometry(color), geometry(mono), `${world.id} preserves geometry`);
    assert.equal(color.match(/<mask[\s\S]*?<\/mask>/)?.[0], mono.match(/<mask[\s\S]*?<\/mask>/)?.[0], 'Color never changes clipping masks');
    for (const [, paint] of color.matchAll(/(?:fill|stroke)="(#[^"]+)"/g)) assert.ok(allowed.has(paint), `Unexpected color ${paint}`);
    const layers = renderWorldLayers(world, { color: true, signals: false });
    assert.equal(layers.objects.length, world.props.length);
    assert.deepEqual(layers.objects.map(({ x, y, depth }) => ({ x, y, depth })),
      renderWorldLayers(world, { signals: false }).objects.map(({ x, y, depth }) => ({ x, y, depth })));
    assert.ok(layers.terrainSvg.includes(`width="44" height="30" fill="${GAME_PALETTE.pond}"`), 'Water uses pond blue');
    assert.ok(layers.terrainSvg.includes(`width="1600" height="1200" fill="${GAME_PALETTE.meadow}"`), 'Ground uses meadow green');
    for (const layer of layers.objects) {
      for (const [, id] of layer.svg.matchAll(/url\(#([^)]*)\)/g)) assert.ok(layer.svg.includes(`id="${id}"`), 'Every layer keeps its own pattern definitions');
    }
  }
  const world = validateWorld(square()), options = { actors: [{ id: 'live', x: 40, y: 40, rows }] };
  const actor = svg => svg.match(/<g class="world-actors"[\s\S]*?<\/g><\/g>/)?.[0];
  assert.equal(actor(renderWorld(world, { ...options, color: true })), actor(renderWorld(world, options)));
  for (const type of PROP_TYPES) {
    assert.equal(renderProp(type, { color: false }), renderProp(type));
    const color = renderProp(type, { color: true });
    assert.equal(geometry(color), geometry(renderProp(type)), `${type} preserves geometry`);
    assert.ok(color.includes(propArtwork(type, `rf-prop-${type}`, { color: true })));
    assert.notEqual(propArtwork(type, 'prop', { color: true }), propArtwork(type, 'prop'));
  }
  for (const invalid of ['yes', 1, null]) {
    assert.throws(() => renderWorld(world, { color: invalid }), /color must be a boolean/);
    assert.throws(() => renderWorldLayers(world, { color: invalid }), /color must be a boolean/);
    assert.throws(() => renderProp('tree', { color: invalid }), /color must be a boolean/);
    assert.throws(() => propArtwork('tree', 'prop', { color: invalid }), /color must be a boolean/);
  }
});

test('land membership preserves courtyard holes, disjoint islands and every missing-chunk stage', () => {
  const geometry = { polygons: [[[0, 0], [288, 0], [288, 288], [0, 288]]],
    holes: [[[80, 80], [120, 80], [120, 120], [80, 120]]], depth: 18 };
  const complete = validateWorld(square({ geometry }));
  assert.equal(worldContains(complete, [40, 40]), true);
  assert.equal(worldContains(complete, [100, 100]), false);
  assert.equal(worldContains(complete, [300, 20]), false);
  assert.equal(isWorldWalkable(complete, [75, 100], 7), false, 'The actor disk cannot overlap a hole');
  assert.equal(isWorldWalkable(complete, [74, 100], 5), true);
  for (const stage of ['void', 'wireframe', 'floating']) {
    const world = validateWorld(square({ geometry, variant: 'loading', missingChunks: [{ x: 144, y: 144, w: 48, h: 48, stage, lift: stage === 'floating' ? 40 : 0 }] }));
    assert.equal(worldContains(world, [160, 160]), false, `${stage} has no loaded floor`);
    assert.equal(isWorldWalkable(world, [140, 160], 7), false);
    const svg = renderWorld(world);
    assert.match(svg, /mask="url\(#rf-test-world-surface\)"/);
    assert.ok(svg.includes(`data-stage="${stage}"`));
  }
  const islands = validateWorld(square({ geometry: {
    polygons: [[[0, 0], [80, 0], [80, 80], [0, 80]], [[144, 0], [224, 0], [224, 80], [144, 80]]], holes: [], depth: 18,
  } }));
  assert.equal(worldContains(islands, [120, 40]), false);
  assert.equal(worldContains(islands, [160, 40]), true);
  const overlapping = validateWorld(square({ geometry: {
    polygons: [[[0, 0], [100, 0], [100, 100], [0, 100]], [[80, 0], [180, 0], [180, 100], [80, 100]]], holes: [], depth: 18,
  } }));
  assert.equal(isWorldWalkable(overlapping, [90, 50], 30), true, 'Overlapping polygons do not create internal collision walls');
});

test('walkability blocks water, scaled prop footprints and game rectangles while preserving decorative props', () => {
  const world = validateWorld(square({ patches: [{ x: 20, y: 20, w: 30, h: 30, pattern: 'water' }],
    props: [{ type: 'tree', x: 100, y: 100, scale: 2 }, { type: 'flower', x: 80, y: 160 }],
    collision: { blocked: [{ x: 180, y: 180, w: 20, h: 20 }] } }));
  assert.equal(worldContains(world, [35, 35]), true, 'Water is on the visual ground but not walkable');
  assert.equal(isWorldWalkable(world, [35, 35]), false);
  assert.equal(isWorldWalkable(world, [55, 35], 6), false);
  assert.equal(isWorldWalkable(world, [57, 35], 6), true);
  assert.equal(isWorldWalkable(world, [110, 100]), false);
  assert.equal(isWorldWalkable(world, [120, 100]), true);
  assert.equal(isWorldWalkable(world, [80, 160]), true);
  assert.equal(isWorldWalkable(world, [185, 185]), false);
  const custom = validateWorld(square({ props: [{ type: 'tree', x: 100, y: 100, footprint: null },
    { type: 'flower', x: 200, y: 100, footprint: { x: -10, y: -10, w: 20, h: 20 } }] }));
  assert.equal(isWorldWalkable(custom, [100, 100]), true);
  assert.equal(isWorldWalkable(custom, [205, 100]), false);
  assert.throws(() => isWorldWalkable(world, [100, 100], -1), /radius/);
});

test('malformed scenes fail before producing markup, including invalid numbers, types, props and anchors', () => {
  for (const mutate of [
    world => { world.geometry.depth = NaN; },
    world => { world.geometry.polygons[0][0][0] = Infinity; },
    world => { world.geometry.polygons[0][0][1] = '0'; },
    world => { world.geometry.polygons = [[[0, 0], [20, 0]]]; },
    world => { world.geometry.polygons = [[[0, 0], [200, 150], [0, 200], [140, 0]]]; },
    world => { world.props = [{ type: '<script>', x: 100, y: 100 }]; },
    world => { world.props = [{ type: 'tree', x: 500, y: 100 }]; },
    world => { world.props = [{ type: 'tree', x: 100, y: 100, scale: '1' }]; },
    world => { world.props = [{ type: 'tree', x: 100, y: 100, footprint: { x: 0, y: 0, w: 0, h: 5 } }]; },
    world => { world.signals = [{ x: 100, y: 100, kind: 'unknown' }]; },
    world => { world.actors = [{ x: 500, y: 50, sprite: 0 }]; },
    world => { world.patches = [{ x: 10, y: 10, w: 20, h: 20, pattern: 'url(https://bad)' }]; },
    world => { world.paths = [{ width: -1, points: [[20, 20], [30, 30]] }]; },
    world => { world.paths = [{ width: 4, points: [[20, 20, 30], [30, 30]] }]; },
    world => { world.variant = 'loading'; },
    world => { world.missingChunks = [{ x: 48, y: 48, w: 48, h: 48, stage: 'void' }]; },
    world => { world.variant = 'loading'; world.missingChunks = [{ x: 40, y: 48, w: 48, h: 48, stage: 'void' }]; },
    world => { world.variant = 'loading'; world.missingChunks = [{ x: 48, y: 48, w: 48, h: 48, stage: 'floating', lift: 0 }]; },
    world => { world.collision = { blocked: [{ x: 200, y: 200, w: '20', h: 20 }] }; },
  ]) {
    const world = square(); mutate(world);
    assert.throws(() => validateWorld(world), /./);
    assert.throws(() => renderWorld(world), /./);
  }
  for (const value of [null, [], 'world', { ...square(), props: {} }]) assert.throws(() => validateWorld(value));
  const hole = square({ geometry: { polygons: [[[0, 0], [288, 0], [288, 288], [0, 288]]], holes: [[[80, 80], [120, 80], [120, 120], [80, 120]]], depth: 18 },
    props: [{ type: 'tree', x: 100, y: 100 }] });
  assert.throws(() => validateWorld(hole), /outside loaded ground/);
});

test('caller-supplied actor pixels stay upright with clipped integer halo and depth-sort with props', () => {
  const world = validateWorld(square({ props: [{ type: 'crate', x: 80, y: 80 }, { type: 'tree', x: 20, y: 20 }] }));
  const svg = renderWorld(world, { actors: [{ id: 'live', x: 40, y: 40, rows }] });
  assert(svg.indexOf('data-prop="tree"') < svg.indexOf('data-actor="live"'));
  assert(svg.indexOf('data-actor="live"') < svg.indexOf('data-prop="crate"'));
  const actor = svg.slice(svg.indexOf('<g class="world-actors"'), svg.indexOf('<g class="world-prop" data-prop="crate"'));
  assert.match(actor, /shape-rendering="crispEdges" transform="translate\(/);
  assert.ok(!actor.includes('matrix(') && !actor.includes('rotate('));
  assert.match(actor, /<g fill="#000"><rect x="0" y="0" width="5" height="5"\/><rect x="75" y="75" width="5" height="5"\/><\/g>/);
  assert.ok(!actor.includes('x="-5"') && !actor.includes('y="-5"'), 'The white halo remains inside the 16 × 16 box');
  assert.deepEqual(sortWorldItems([{ x: 30, y: 10, id: 'a' }, { x: 10, y: 30, id: 'b' }, { x: 1, y: 1, id: 'c' }]).map(item => item.id), ['c', 'a', 'b']);
  for (const actor of [{ x: 500, y: 20, rows }, { x: 20, y: 20, rows: ['#'] },
    { x: 20, y: 20, rows: Array(16).fill('<script>alert(1)') }, { x: 20, y: 20, rows, pixelScale: 1.5 }]) {
    assert.throws(() => renderWorld(world, { actors: [actor] }));
  }
});

test('layers are self-contained, contain only requested static art, and preserve depth order', () => {
  const garden = getWorldPreset('01-garden-oval-complete');
  const layers = renderWorldLayers(garden, { signals: false });
  assert.equal(layers.objects.length, garden.props.length);
  assert.ok(!layers.terrainSvg.includes('class="world-prop"'));
  assert.ok(!layers.terrainSvg.includes('class="world-actors"'));
  assert.ok(layers.terrainSvg.includes('class="world-terrain"'));
  assert.ok(layers.objects.every(item => item.svg.startsWith('<svg') && item.svg.includes('<defs>') && item.kind === 'prop'));
  assert.deepEqual(layers.objects.map(item => item.depth), layers.objects.map(item => item.depth).sort((a, b) => a - b));
  assert.equal(renderWorldLayers(garden).objects.length, garden.props.length + garden.signals.length);
  assert.throws(() => renderWorld(garden, { background: 'url(https://bad)' }), /background/);
  assert.throws(() => renderWorldLayers(garden, { signals: 'yes' }), /boolean/);
});

test('text metadata is escaped and reusable props carry their transparent canvas and ground anchor', () => {
  const world = validateWorld(square({ id: 'test"><script>', name: '<script>"Friends" & world</script>', summary: "A <tiny> 'world'" }));
  const svg = renderWorld(world, { actors: [{ x: 20, y: 20, rows, id: '"><script>bad</script>' }] });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;&quot;Friends&quot; &amp; world&lt;/script&gt;'));
  assert.ok(svg.includes('data-actor="&quot;&gt;&lt;script&gt;bad&lt;/script&gt;"'));
  assert.deepEqual(PROP_CANVAS, { width: 240, height: 240, anchorX: 120, anchorY: 180 });
  for (const type of PROP_TYPES) {
    const svg = renderProp(type);
    assert.match(svg, /viewBox="-120 -180 240 240"/);
    assert.match(svg, /data-anchor-x="120" data-anchor-y="180"/);
    assert.ok(svg.includes('<defs>') && !svg.includes('world-terrain') && !svg.includes('<image'));
    assert.ok(svg.includes(propArtwork(type, `rf-prop-${type}`)), 'The same prop artwork is reused');
  }
  assert.throws(() => renderProp('unsupported'), /prop type/);
  assert.throws(() => propArtwork('tree', '"><script>'), /identifier/);
});

test('the complete SDK bundles for browsers without Node runtime or character snapshot dependencies', async () => {
  const result = await build({ entryPoints: [new URL('../src/friend-world.ts', import.meta.url).pathname],
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true });
  const inputs = Object.keys(result.metafile.inputs);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(path => /friend-world(?:s\.json|\.ts)$/.test(path)));
  assert.ok(!result.outputFiles[0].text.includes('node:fs'));
});
