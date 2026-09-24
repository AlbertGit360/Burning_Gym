import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERATION_SPRITE_MANIFEST, SPRITE_FACINGS, createGenerationSpriteReader,
  decodeGenerationSprites, decodeSpriteBitmap, generationSpriteCacheKey,
  spriteFrame,
} from '../dist/generation-sprites.js';
import { readGenerationEligibility } from '../dist/identity.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const UINT256_MAX = (1n << 256n) - 1n;

function fixture() {
  const state = { chain: 4663, block: 10n, owner: OWNER, generation: 3, position: [0, 1450n],
    activationManager: OTHER, retired: false, failFrames: false, missing: false };
  const calls = [];
  const client = {
    async getChainId() { return state.chain; },
    async getBlockNumber(options) { assert.equal(options.cacheTime, 0); return state.block; },
    async readContract(call) {
      calls.push(call);
      switch (call.functionName) {
        case 'familyOf': return 5;
        case 'seedOf': return Number(call.args[0]);
        case 'frames':
          if (state.failFrames) throw new Error('temporary RPC failure');
          return Array(64).fill(1n);
        case 'ownerOf':
          if (state.missing) throw new Error('ERC721NonexistentToken');
          return state.owner;
        case 'generation': return state.generation;
        case 'positions': return state.position;
        case 'activationManager': return state.activationManager;
        case 'retired': return state.retired;
        default: throw new Error('Unexpected RPC method');
      }
    },
  };
  return { state, calls, client };
}

test('bitmap orientation preserves every corner and never wraps pixels across rows', () => {
  const bitmap = 1n | (1n << 15n) | (1n << 16n) | (1n << 240n) | (1n << 255n);
  const decoded = decodeSpriteBitmap(bitmap);
  assert.equal(decoded.rows.length, 16);
  assert.equal(decoded.rows[0], '#..............#');
  assert.equal(decoded.rows[1], '#...............');
  assert.equal(decoded.rows[15], '#..............#');
  assert.ok(decoded.rows.slice(2, 15).every(row => row === '................'));
  assert.ok(decodeSpriteBitmap(UINT256_MAX).rows.every(row => row === '################'));
  assert.ok(decodeSpriteBitmap(0n).rows.every(row => row === '................'));
  for (const invalid of [-1n, UINT256_MAX + 1n, 1, '1']) assert.throws(() => decodeSpriteBitmap(invalid), /uint256/);
});

test('all 64 slots retain action, direction and gait index without coercion', () => {
  const frames = Array.from({ length: 64 }, (_, slot) => 1n << BigInt(slot));
  const sprites = decodeGenerationSprites(3412n, 0, 3412, frames);
  for (const walking of [false, true]) for (const [direction, facing] of SPRITE_FACINGS.entries()) {
    for (let gait = 0; gait < 8; gait++) {
      const selected = spriteFrame(sprites, facing, walking, gait);
      assert.equal(selected.frame.bitmap, frames[(walking ? 32 : 0) + direction * 8 + gait]);
      assert.equal(selected.usedFallback, false);
    }
  }
  assert.throws(() => spriteFrame(sprites, 'down', true, 8), /Frame/);
  assert.throws(() => spriteFrame(sprites, 'down', true, -1), /Frame/);
  assert.throws(() => spriteFrame(sprites, 'north', true, 0), /direction/);
  assert.throws(() => { sprites.clips.walk.left[0].rows[0] = 'wrong'; }, TypeError);
  assert.throws(() => { sprites.frames[0] = 0n; }, TypeError);
});

test('Colossus vertical fallback is explicit, selectable and retains idle versus walk', () => {
  const frames = Array.from({ length: 64 }, (_, slot) => slot % 32 < 16 ? 0n : BigInt(slot));
  const sprites = decodeGenerationSprites(86309n, 6, 86309, frames);
  assert.equal(sprites.clips.walk.up[0].bitmap, 0n, 'The source data remains unchanged');
  assert.deepEqual(spriteFrame(sprites, 'up', true, 2), {
    frame: sprites.clips.walk.right[2], requestedFacing: 'up', resolvedFacing: 'right', usedFallback: true,
  });
  assert.equal(spriteFrame(sprites, 'down', false, 3, 'left').frame.bitmap, 19n);
  assert.equal(spriteFrame(sprites, 'left', true, 2).usedFallback, false);
  const other = decodeGenerationSprites(1n, 0, 1, Array(64).fill(0n));
  assert.equal(spriteFrame(other, 'up', true, 0).usedFallback, false, 'Zero data is not silently relabeled as Colossus');
});

test('invalid token IDs and malformed results fail before caching or network reads', async () => {
  const f = fixture(), reader = createGenerationSpriteReader(f.client);
  for (const id of [0n, -1n, UINT256_MAX + 1n, 1, '1']) {
    await assert.rejects(reader.read(id), /Token ID/);
    await assert.rejects(readGenerationEligibility(f.client, id), /Token ID/);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => decodeGenerationSprites(1n, 9, 1, Array(64).fill(0n)), /family/);
  assert.throws(() => decodeGenerationSprites(1n, 0, 2 ** 32, Array(64).fill(0n)), /uint32/);
  assert.throws(() => decodeGenerationSprites(1n, 0, 1, Array(63).fill(0n)), /64/);
  assert.match(generationSpriteCacheKey(UINT256_MAX), /115792089237316195423570985/);
});

test('immutable reads coalesce, retry RPC failures and reject a chain switch even on cache hits', async () => {
  const f = fixture(), reader = createGenerationSpriteReader(f.client);
  const results = await Promise.all(Array.from({ length: 5 }, () => reader.read(7730n)));
  assert.ok(results.every(result => result === results[0]));
  assert.deepEqual(f.calls.map(call => call.functionName).sort(), ['familyOf', 'frames', 'seedOf']);
  f.state.chain = 1;
  await assert.rejects(reader.read(7730n), /chain 4663/);
  f.state.chain = 4663;
  f.state.failFrames = true;
  await assert.rejects(reader.read(7731n), /temporary RPC/);
  f.state.failFrames = false;
  assert.equal((await reader.read(7731n)).tokenId, 7731n);
  reader.clear();
  await reader.read(7730n);
  assert.equal(f.calls.filter(call => call.functionName === 'frames').length, 4);
});

test('cache keys distinguish chain, registry and full-width token ID', () => {
  const a = generationSpriteCacheKey(1n);
  assert.notEqual(a, generationSpriteCacheKey(2n));
  assert.notEqual(a, generationSpriteCacheKey(1n, { ...GENERATION_SPRITE_MANIFEST, chainId: 1 }));
  assert.notEqual(a, generationSpriteCacheKey(1n, { ...GENERATION_SPRITE_MANIFEST, registry: OTHER }));
  assert.equal(a, generationSpriteCacheKey(1n, { ...GENERATION_SPRITE_MANIFEST, registry: GENERATION_SPRITE_MANIFEST.registry.toLowerCase() }));
});

test('eligibility requires only current ownership of a hardwired Generations NFT at one block', async () => {
  const f = fixture();
  f.state.position = [0, 0n]; f.state.retired = true;
  const first = await readGenerationEligibility(f.client, 7730n, OWNER);
  assert.equal(first.eligible, true);
  assert.equal(first.blockNumber, 10n);
  assert.deepEqual(f.calls.map(call => call.functionName), ['ownerOf', 'generation']);
  assert.ok(f.calls.every(call => call.blockNumber === 10n));
  f.state.owner = OTHER; f.state.block = 11n;
  assert.equal((await readGenerationEligibility(f.client, 7730n, OWNER)).eligible, false);
  assert.ok(f.calls.slice(-2).every(call => call.blockNumber === 11n));
  const viewOnly = await readGenerationEligibility(f.client, 7730n);
  assert.equal(viewOnly.ownedByPlayer, null); assert.equal(viewOnly.eligible, null);
  f.state.owner = OWNER; f.state.generation = 0;
  assert.equal((await readGenerationEligibility(f.client, 7730n, OWNER)).eligible, false);
  f.state.missing = true;
  await assert.rejects(readGenerationEligibility(f.client, 7730n, OWNER), /NonexistentToken/);
  f.state.chain = 1;
  await assert.rejects(readGenerationEligibility(f.client, 7730n, OWNER), /chain 4663/);
});
