import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldNavigator } from '../dist/friend-navigation.js';
import { createWorldMovement } from '../dist/movement.js';
import { project, validateWorld } from '../dist/friend-world.js';

function square(blocked = []) {
  return validateWorld({ id: 'test', name: 'Test', family: 'test', setting: 'Garden', shape: 'Square',
    summary: 'Movement fixture', variant: 'complete', geometry: {
      polygons: [[[0, 0], [288, 0], [288, 288], [0, 288]]], holes: [], depth: 18,
    }, props: [], actors: [], paths: [], patches: [], signals: [], missingChunks: [], collision: { blocked } });
}

test('arrows and WASD normalize diagonal speed and cancel opposite directions', () => {
  const spawn = [120, 120], world = square();
  const run = keys => {
    const movement = createWorldMovement(world, spawn);
    for (const key of keys) movement.setKey(key, true);
    return movement.update(20);
  };
  const distance = state => {
    const [sx, sy] = project(...spawn), [x, y] = project(...state.position);
    return Math.hypot(x - sx, y - sy);
  };
  assert.ok(Math.abs(distance(run(['ArrowUp'])) - 3.4) < 1e-8);
  assert.ok(Math.abs(distance(run(['ArrowUp', 'w', 'ArrowRight'])) - 3.4) < 0.001);
  assert.deepEqual(run(['a', 'd']).position, spawn);
  assert.equal(run(['ArrowUp', 'd']).facing, 'right');
});

test('click route avoids a blocking wall and reaches its destination without crossing it', () => {
  const world = square([{ x: 125, y: 30, w: 25, h: 200 }]);
  const navigator = createWorldNavigator(world), spawn = [70, 110], goal = [210, 110];
  assert.equal(navigator.segmentClear(spawn, goal), false);
  const movement = createWorldMovement(world, spawn);
  assert.equal(movement.moveTo(goal), true);
  let prior = spawn;
  for (let frame = 0; frame < 1000 && movement.state.destination; frame++) {
    const next = movement.update(20);
    assert.equal(navigator.segmentClear(prior, next.position), true);
    prior = next.position;
  }
  assert.deepEqual(movement.state.position, goal);
  assert.equal(movement.state.destination, null);
  assert.equal(movement.moveTo([130, 110]), false);
});

test('manual input cancels navigation; stop clears held keys and suspended tabs do not teleport', () => {
  const world = square(), movement = createWorldMovement(world, [120, 120]);
  movement.moveTo([160, 160]); movement.setKey('w', true);
  assert.equal(movement.state.destination, null);
  const limited = movement.update(10_000);
  const [sx, sy] = project(120, 120), [x, y] = project(...limited.position);
  assert.ok(Math.abs(Math.hypot(x - sx, y - sy) - 6.8) < 1e-8);
  movement.stop(); assert.deepEqual(movement.update(20).position, limited.position);
  movement.reset(); assert.deepEqual(movement.state.position, [120, 120]);
  assert.equal(movement.setKey('e', true), false);
});
