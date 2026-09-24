import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RF, parseChanceGame, defineChanceGame, maximumPrize, expectedReward, outcomeForRoll, createGamePreview } from '../dist/game.js';

const fishingJSON = JSON.parse(await readFile(new URL('../examples/fishing/game.json', import.meta.url)));
const fishing = parseChanceGame(fishingJSON);
const preview = (stake = 10n * RF, draw = () => 9999) => createGamePreview(fishing, { stake, rfBalance: 100n * RF, draw });

function backed(state) {
  assert.equal(state.stake, state.freeStake + state.reservedPlays + state.rewardLiability);
  assert.ok(state.freeStake >= 0n);
  assert.equal(state.rewardLiability, state.inventory.reduce((sum, count, index) => sum + count * fishing.outcomes[index].reward, 0n));
  assert.equal(state.reservedPlays, (state.consumables + BigInt(state.plays.filter(play => play.outcomeId === null).length)) * 10n * RF);
}

test('fishing JSON has exact probabilities, boundaries, maximum prize and 90% expected return', () => {
  assert.equal(maximumPrize(fishing), 10n * RF);
  assert.equal(expectedReward(fishing), 9n * RF / 10n);
  const counts = new Array(8).fill(0);
  for (let roll = 0; roll < 10000; roll++) counts[outcomeForRoll(fishing, roll) - 1]++;
  assert.deepEqual(counts, [1500, 3000, 2200, 1400, 900, 500, 300, 200]);
  assert.throws(() => outcomeForRoll(fishing, 10000));
  assert.throws(() => parseChanceGame({ ...fishingJSON, price: 1 }));
  assert.throws(() => parseChanceGame({ ...fishingJSON, outcomes: [{ name: 'Bad', chanceBps: 9999, reward: '1' }] }));
});

test('underfunded games take no RF and funding enables a purchase without an arbitrary minimum', async () => {
  const game = preview(9n * RF), before = await game.client.read();
  assert.equal(await game.client.canBuy(1n), false);
  await assert.rejects(game.client.buy(1n), /free stake/);
  assert.deepEqual(await game.client.read(), before);
  game.fund(RF);
  await game.client.buy(1n);
  const state = await game.client.read();
  assert.equal(state.freeStake, RF);
  assert.equal(state.reservedPlays, 10n * RF);
  backed(state);
});

test('unused bait stays backed and playable after all free stake is withdrawn', async () => {
  const game = preview();
  await game.client.buy(1n);
  assert.throws(() => game.withdraw(2n * RF), /reserved/);
  game.withdraw(RF);
  assert.equal(await game.client.canBuy(1n), false);
  const [play] = await game.client.play();
  backed(await game.client.read());
  const caught = await game.client.settle(play.id);
  assert.equal(caught.outcomeId, 8);
  assert.equal((await game.client.read()).rewardLiability, 10n * RF);
  assert.throws(() => game.withdraw(1n), /reserved/);
  await game.client.redeem(8, 1n);
  const state = await game.client.read();
  assert.equal(state.stake, 0n);
  assert.equal(state.rfBalance, 109n * RF);
  backed(state);
});

test('concurrent purchases cannot reuse backing; rejected batch is atomic', async () => {
  const game = preview();
  const results = await Promise.allSettled([game.client.buy(1n), game.client.buy(1n)]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  backed(await game.client.read());
  const bulk = preview(20n * RF);
  const before = await bulk.client.read();
  await assert.rejects(bulk.client.buy(3n));
  assert.deepEqual(await bulk.client.read(), before);
  await bulk.client.buy(2n);
  assert.equal((await bulk.client.read()).reservedPlays, 20n * RF);
  backed(await bulk.client.read());
});

test('settlement releases only the unused prize reserve and cannot reroll', async () => {
  let calls = 0;
  const game = preview(10n * RF, () => { calls++; return 1500; });
  await game.client.buy(1n);
  const [play] = await game.client.play();
  await game.client.settle(play.id);
  let state = await game.client.read();
  assert.equal(state.freeStake, 1075n * RF / 100n);
  assert.equal(state.rewardLiability, RF / 4n);
  await assert.rejects(game.client.settle(play.id), /already settled/);
  assert.equal(calls, 1);
  assert.deepEqual(await game.client.read(), state);
  await game.client.redeem(2, 1n);
  state = await game.client.read();
  await assert.rejects(game.client.redeem(2, 1n), /inventory/);
  assert.deepEqual(await game.client.read(), state);
  backed(state);
});

test('kept rewards have no expiry input and remain fully reserved through subsequent play', async () => {
  const game = preview(100n * RF, () => 5000);
  for (let index = 0; index < 8; index++) {
    await game.client.buy(1n);
    const [play] = await game.client.play();
    await game.client.settle(play.id);
    backed(await game.client.read());
  }
  const state = await game.client.read();
  assert.equal(state.inventory[2], 8n);
  assert.equal(state.rewardLiability, 4n * RF);
  game.withdraw(state.freeStake);
  await game.client.redeem(3, 8n);
  assert.equal((await game.client.read()).stake, 0n);
  backed(await game.client.read());
});

test('invalid preview draw leaves the committed play intact; boots are permanent collectibles', async () => {
  let roll = -1;
  const game = preview(10n * RF, () => roll);
  await game.client.buy(1n);
  const [play] = await game.client.play(), before = await game.client.read();
  await assert.rejects(game.client.settle(play.id));
  assert.deepEqual(await game.client.read(), before);
  roll = 0;
  await game.client.settle(play.id);
  await assert.rejects(game.client.redeem(1, 1n), /no RF/);
  assert.equal((await game.client.read()).inventory[0], 1n);
  backed(await game.client.read());
});

test('a different chance game uses only configuration with the same client', async () => {
  const game = createGamePreview(defineChanceGame({ name: 'Treasure chest', consumable: 'Key', price: 2n * RF,
    outcomes: [{ name: 'Stone', chanceBps: 7500, reward: 0n }, { name: 'Gem', chanceBps: 2500, reward: 6n * RF }] }),
  { stake: 6n * RF, rfBalance: 2n * RF, draw: () => 9000 });
  await game.client.buy(1n);
  const [play] = await game.client.play();
  await game.client.settle(play.id);
  await game.client.redeem(2, 1n);
  assert.equal((await game.client.read()).rfBalance, 6n * RF);
  assert.equal((await game.client.read()).freeStake, 2n * RF);
});
