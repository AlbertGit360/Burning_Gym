import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeAbiParameters, encodeEventTopics, getAbiItem, http, parseAbi, zeroAddress, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLiveGameClient, LIVE_GAME_MAX_ORACLE_FEE } from '../dist/live-game.js';
import { CHANCE_GAME_ABI } from '../dist/chance-game-abi.js';
import { fundFriendWallet } from '../dist/friend-funding.js';
import { MAINNET, ROOT } from '../scripts/contracts/common.mjs';
import { deployGame, fundDeployment } from '../scripts/contracts/deploy.mjs';

const GAME = '0x1111111111111111111111111111111111111111', GENERATIONS = '0x2222222222222222222222222222222222222222';
const RF = '0x3333333333333333333333333333333333333333', OWNER = '0x4444444444444444444444444444444444444444';
const FRIEND = '0x5555555555555555555555555555555555555555', CONSUMABLE = '0x6666666666666666666666666666666666666666';
const ENTROPY = '0x7777777777777777777777777777777777777777', PROVIDER = '0x8888888888888888888888888888888888888888';
const HASH = `0x${'ab'.repeat(32)}`;
const deployment = { chainId: 4663, game: GAME, generations: GENERATIONS, rf: RF, entropy: ENTROPY, provider: PROVIDER, deploymentBlock: 50n };
const definition = { name: 'Test', consumable: 'Bait', price: 10n, outcomes: [{ name: 'Small', chanceBps: 9000, reward: 1n }, { name: 'Large', chanceBps: 1000, reward: 100n }] };
const TOKEN = parseAbi(['function approve(address spender,uint256 amount) returns(bool)', 'event Approval(address indexed owner,address indexed spender,uint256 value)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
function event(abi, name, args, address = GAME) {
  const nonindexed = getAbiItem({ abi, name }).inputs.filter(input => !input.indexed);
  return { address, args, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(nonindexed, nonindexed.map(input => args[input.name])),
    blockNumber: 100n, blockHash: HASH, transactionHash: HASH, transactionIndex: 0, logIndex: 0, removed: false };
}
function fixture(changes = {}) {
  const state = { block: 100n, balance: 70n, consumables: 3n, allowance: 0n, active: true, requested: false, fulfilled: false, outcome: 0n,
    hasPlay: true, fee: 25_000_000_000_000n, boundEntropy: ENTROPY, price: 10n, waitError: false, badRequestEvent: false, ...changes };
  const reads = [], writes = [], readsAtWrite = [], historyCalls = [], receipts = new Map();
  const publicClient = {
    async getChainId() { return 4663; }, async getBlockNumber() { return state.block; }, async getBlock() { return { hash: HASH }; },
    async getLogs(call) { historyCalls.push(call); assert.equal(call.address, GAME); assert.deepEqual(call.args, { friendId: 5n }); assert.equal(call.fromBlock, 50n);
      return state.hasPlay ? [event(CHANCE_GAME_ABI, 'Played', { friendId: 5n, playId: 7n, batchId: 9n })] : []; },
    async readContract(call) {
      reads.push(call); const [first] = call.args ?? [];
      switch (call.functionName) {
        case 'rf': return RF; case 'generations': return GENERATIONS; case 'entropy': return state.boundEntropy; case 'provider': return PROVIDER;
        case 'consumable': return CONSUMABLE; case 'price': return state.price; case 'maxPrize': return 100n; case 'outcomeCount': return 2n;
        case 'ownerOf': case 'owner': return OWNER; case 'generation': return 1; case 'tokenBoundAccount': return FRIEND; case 'token': return [4663n, GENERATIONS, 5n];
        case 'reservedPlays': return state.hasPlay && state.outcome === 0n ? 100n : 0n; case 'rewardLiability': return state.outcome > 0n ? 100n : 0n;
        case 'balanceOf': return call.address === CONSUMABLE ? state.consumables : first === GAME ? 1000n : state.balance;
        case 'balanceOfBatch': return [0n, state.outcome > 0n ? 1n : 0n]; case 'outcomes': return first === 1n ? [9000, 1n, 'small'] : [1000, 100n, 'large'];
        case 'allowance': return state.allowance; case 'plays': assert.equal(first, 7n); return [5n, state.hasPlay ? 9n : 0n, state.outcome];
        case 'randomness': return [state.requested ? 1n : 0n, state.requested, state.fulfilled, zeroHash];
        case 'getFeeV2': return state.fee; default: throw new Error(`Unexpected read ${call.functionName}`);
      }
    },
    async simulateContract() { throw new Error('SDK must not simulate before a wallet prompt'); },
    async waitForTransactionReceipt({ hash }) { if (state.waitError) throw new Error('Fixture receipt unavailable'); return receipts.get(hash); },
  };
  const walletClient = { chain: { id: 4663 }, async getChainId() { return 4663; }, async getAddresses() { if (state.invalidateBeforePrompt) state.active = false; return [OWNER]; },
    async writeContract(request) {
      assert(state.active, 'No write after the host session invalidates');
      const action = request.functionName === 'execute' ? decodeFunctionData({ abi: request.args[0] === RF ? TOKEN : CHANCE_GAME_ABI, data: request.args[2] }) : request;
      readsAtWrite.push(reads.length); writes.push(action); state.block++; const hash = `0x${writes.length.toString(16).padStart(64, '0')}`; let logs;
      if (action.functionName === 'approve') { state.allowance = action.args[1]; logs = [event(TOKEN, 'Approval', { owner: FRIEND, spender: GAME, value: state.allowance }, RF)]; }
      else if (action.functionName === 'buy') { const count = action.args[1]; state.balance -= count * 10n; state.consumables += count;
        logs = [event(CHANCE_GAME_ABI, 'Purchased', { friendId: 5n, quantity: count, payment: count * 10n }), event(TOKEN, 'Transfer', { from: FRIEND, to: GAME, value: count * 10n }, RF), event(TOKEN, 'Transfer', { from: zeroAddress, to: FRIEND, value: count }, CONSUMABLE)]; }
      else if (action.functionName === 'play') { state.hasPlay = true; state.consumables--; logs = [event(CHANCE_GAME_ABI, 'Played', { playId: 7n, friendId: 5n, batchId: 9n }), event(TOKEN, 'Transfer', { from: FRIEND, to: zeroAddress, value: 1n }, CONSUMABLE)]; }
      else if (action.functionName === 'requestRandomness') { state.requested = true; logs = state.badRequestEvent ? [] : [event(CHANCE_GAME_ABI, 'RandomnessRequested', { batchId: 9n, sequenceNumber: 1n })]; }
      else if (action.functionName === 'settle') { state.outcome = 2n; logs = [event(CHANCE_GAME_ABI, 'Settled', { playId: 7n, friendId: 5n, outcomeId: 2n }), event(CHANCE_GAME_ABI, 'TransferSingle', { operator: OWNER, from: zeroAddress, to: FRIEND, id: 2n, value: 1n })]; }
      else if (action.functionName === 'redeem') { logs = [event(CHANCE_GAME_ABI, 'Redeemed', { friendId: 5n, outcomeId: action.args[1], quantity: action.args[2], payment: action.args[2] * 100n }), event(CHANCE_GAME_ABI, 'TransferSingle', { operator: OWNER, from: FRIEND, to: zeroAddress, id: action.args[1], value: action.args[2] }), event(TOKEN, 'Transfer', { from: GAME, to: FRIEND, value: action.args[2] * 100n }, RF)]; }
      else if (action.functionName === 'transfer') { logs = state.badFundingEvent ? [] : [event(TOKEN, 'Transfer', { from: OWNER, to: action.args[0], value: action.args[1] }, RF)]; }
      else throw new Error(`Unexpected write ${action.functionName}`);
      receipts.set(hash, { status: 'success', transactionHash: hash, blockHash: HASH, blockNumber: state.block, from: OWNER, to: request.address, logs });
      if (state.invalidateAfterApproval && action.functionName === 'approve') state.active = false;
      return hash;
    },
  };
  const options = { definition, deployment, friendId: 5n, account: OWNER, publicClient, walletClient,
    assertActive() { if (!state.active) throw new Error('Session changed'); }, waitMs: 0 };
  const client = createLiveGameClient(options);
  return { state, reads, writes, readsAtWrite, historyCalls, client, options };
}

test('live reads recover only selected Friend history and retain confirmed outcome IDs without local randomness', async () => {
  const f = fixture(); const state = await f.client.read();
  assert.equal(state.mode, 'chain'); assert.equal(state.rfBalance, 70n); assert.deepEqual(state.plays, [{ id: 7n, outcomeId: null }]);
  f.state.outcome = 2n; assert.deepEqual((await f.client.read()).plays, [{ id: 7n, outcomeId: 2 }]); assert.equal(f.writes.length, 0);
});
test('live reads reject mismatched deployment economics and Dice dependencies before signing', async () => {
  for (const options of [{ price: 11n }, { boundEntropy: OWNER }]) {
    const f = fixture(options); await assert.rejects(f.client.buy(1n), /match/); assert.equal(f.writes.length, 0);
  }
});
test('purchase approves exact canonical-wallet allowance, then pays through the verified transport', async () => {
  const f = fixture(); await f.client.buy(2n);
  assert.deepEqual(f.writes.map(action => action.functionName), ['approve', 'buy']); assert.deepEqual(f.writes[0].args, [GAME, 20n]);
  const allowed = fixture({ allowance: 10n }); await allowed.client.buy(1n); assert.deepEqual(allowed.writes.map(action => action.functionName), ['buy']);
});
test('session invalidation before the wallet prompt or after approval prevents every subsequent write', async () => {
  const before = fixture({ invalidateBeforePrompt: true }); await assert.rejects(before.client.buy(1n), /Session changed/); assert.equal(before.writes.length, 0);
  const between = fixture({ invalidateAfterApproval: true }); await assert.rejects(between.client.buy(1n), /Session changed/); assert.deepEqual(between.writes.map(action => action.functionName), ['approve']);
  const dice = fixture({ invalidateBeforePrompt: true }); await assert.rejects(dice.client.settle(7n), /Session changed/); assert.equal(dice.writes.length, 0);
});
test('a pending cast cannot consume another purchased consumable', async () => {
  const f = fixture(); await assert.rejects(f.client.play(), /Cast #7 is pending/); assert.equal(f.writes.length, 0);
  const newPlay = fixture({ hasPlay: false }); assert.deepEqual(await newPlay.client.play(), [{ id: 7n, outcomeId: null }]);
  await assert.rejects(newPlay.client.play(), /Cast #7 is pending/); assert.equal(newPlay.writes.length, 1);
});
test('Dice request uses its exact bounded fee once, pending retries reuse it, and fulfillment settles the same cast', async () => {
  const f = fixture(); assert.deepEqual(await f.client.settle(7n), { id: 7n, outcomeId: null });
  assert.equal(f.writes[0].value, f.state.fee); assert.deepEqual(f.writes.map(action => action.functionName), ['requestRandomness']);
  assert.deepEqual(await f.client.settle(7n), { id: 7n, outcomeId: null }); assert.equal(f.writes.length, 1);
  f.state.fulfilled = true; assert.deepEqual(await f.client.settle(7n), { id: 7n, outcomeId: 2 });
  assert.deepEqual(f.writes.map(action => action.functionName), ['requestRandomness', 'settle']);
  assert.deepEqual(await f.client.settle(7n), { id: 7n, outcomeId: 2 }); assert.equal(f.writes.length, 2);
});
test('excessive fees and unverified receipts cannot trigger another Dice payment', async () => {
  const expensive = fixture({ fee: LIVE_GAME_MAX_ORACLE_FEE + 1n }); await assert.rejects(expensive.client.settle(7n), /approved maximum/); assert.equal(expensive.writes.length, 0);
  for (const options of [{ waitError: true }, { badRequestEvent: true }]) {
    const f = fixture(options); await assert.rejects(f.client.settle(7n), /inspect/i);
    await assert.rejects(f.client.settle(7n), /inspect/i); assert.equal(f.writes.length, 1);
  }
});
test('trusted Friend funding verifies the exact canonical-wallet transfer and rejects stale sessions', async () => {
  const f = fixture(); await fundFriendWallet({ ...f.options, amount: 25n });
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].address, RF); assert.deepEqual(f.writes[0].args, [FRIEND, 25n]);
  f.state.active = false; await assert.rejects(fundFriendWallet({ ...f.options, amount: 25n }), /Session changed/); assert.equal(f.writes.length, 1);
  const changed = fixture({ invalidateBeforePrompt: true }); await assert.rejects(fundFriendWallet({ ...changed.options, amount: 25n }), /Session changed/); assert.equal(changed.writes.length, 0);
  const bad = fixture({ badFundingEvent: true }); await assert.rejects(fundFriendWallet({ ...bad.options, amount: 25n }), { code: 'unverified' });
});

test('initialized actions use session metadata without repeated ownership, balances, history or simulations', async () => {
  const f = fixture({ hasPlay: false }); await f.client.read();
  let count = f.reads.length;
  await f.client.buy(1n);
  assert.deepEqual(f.reads.slice(count).map(call => call.functionName), ['allowance']);
  assert.deepEqual(f.readsAtWrite, [count + 1, count + 1]);
  count = f.reads.length;
  // Even stale display balances/inventory do not gate the transaction; contracts decide.
  f.state.balance = 0n; f.state.consumables = 0n;
  await f.client.play(); assert.equal(f.readsAtWrite.at(-1), count);
  assert.equal(f.historyCalls.length, 1);
  count = f.reads.length;
  await f.client.settle(7n);
  assert.deepEqual(f.reads.slice(count, f.readsAtWrite.at(-1)).map(call => call.functionName), ['randomness', 'getFeeV2']);
  f.state.fulfilled = true; count = f.reads.length;
  await f.client.settle(7n);
  assert.deepEqual(f.reads.slice(count, f.readsAtWrite.at(-1)).map(call => call.functionName), ['randomness']);
  count = f.reads.length; await f.client.redeem(2, 1n); assert.equal(f.readsAtWrite.at(-1), count);
  assert.equal(f.historyCalls.length, 1);
});
test('funding uses the verified canonical wallet without contract reads or simulation before signing', async () => {
  const f = fixture(); await fundFriendWallet({ ...f.options, friendWallet: FRIEND, amount: 25n });
  assert.equal(f.readsAtWrite[0], 0); assert.equal(f.reads.length, 0);
  const cold = fixture(); await fundFriendWallet({ ...cold.options, amount: 25n });
  assert.deepEqual(cold.reads.map(call => call.functionName), ['tokenBoundAccount']);
});

const artifactPath = resolve(ROOT, 'contracts/out/ChanceGame.sol/ChanceGame.json');
test('local Anvil: live adapter funds canonical wallet, buys, recovers pending cast, sponsors Dice once and redeems', {
  skip: spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0 || !existsSync(artifactPath) ? 'Build local contracts and install Anvil for this integration.' : false,
  timeout: 30_000,
}, async () => {
  const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
  const port = reservation.address().port; await new Promise(done => reservation.close(done));
  const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--silent'], { stdio: 'ignore' });
  // Published local Anvil fixture key; it is used only with the loopback RPC below.
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const chain = defineChain({ id: 4663, name: 'Local test only', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } });
  const rpc = http(chain.rpcUrls.default.http[0], { retryCount: 0, timeout: 1000 });
  const publicClient = createPublicClient({ chain, transport: rpc, pollingInterval: 10, cacheTime: 0 });
  const walletClient = createWalletClient({ account, chain, transport: rpc, cacheTime: 0 });
  try {
    for (let attempt = 0; ; attempt++) { try { await publicClient.getChainId(); break; } catch (error) { if (attempt > 100) throw error; await new Promise(done => setTimeout(done, 25)); } }
    const load = async name => JSON.parse(await readFile(resolve(ROOT, `contracts/out/${name}`), 'utf8'));
    const [built, rf, generations, dice] = await Promise.all([load('ChanceGame.sol/ChanceGame.json'), load('ChanceGame.t.sol/MockRF.json'), load('ChanceGame.t.sol/MockGenerations.json'), load('ChanceGame.t.sol/MockDice.json')]);
    const write = async (address, abi, functionName, args) => { const hash = await walletClient.writeContract({ address, abi, functionName, args }); assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success'); };
    for (const [address, artifact, args] of [[MAINNET.rf, rf, []], [MAINNET.generations, generations, [MAINNET.rf]], [MAINNET.entropy, dice, [MAINNET.provider]]]) {
      const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      await publicClient.request({ method: 'anvil_setCode', params: [address, await publicClient.getCode({ address: receipt.contractAddress })] });
    }
    await write(MAINNET.rf, rf.abi, 'mint', [account.address, 5000n]);
    const manifest = await deployGame({ client: publicClient, wallet: walletClient, account, definition, built, initialStake: 1000n, save: async () => {} });
    await fundDeployment({ client: publicClient, wallet: walletClient, account, abi: built.abi, manifest, save: async () => {} });
    await write(MAINNET.generations, generations.abi, 'mint', [account.address, 5n, 1]);
    const canonical = await publicClient.readContract({ address: MAINNET.generations, abi: generations.abi, functionName: 'tokenBoundAccount', args: [5n] });
    const options = { definition, deployment: manifest, friendId: 5n, friendWallet: canonical, account: account.address, publicClient, walletClient, waitMs: 0 };
    await fundFriendWallet({ ...options, amount: 50n });
    const live = createLiveGameClient(options);
    assert.equal((await live.read()).rfBalance, 50n); await live.buy(1n);
    const [committed] = await live.play(); assert.equal(committed.outcomeId, null);
    const recovered = createLiveGameClient(options); assert.deepEqual((await recovered.read()).plays, [committed]);
    await assert.rejects(recovered.play(), /pending/);
    assert.deepEqual(await recovered.settle(committed.id), committed);
    const nonce = await publicClient.getTransactionCount({ address: account.address });
    assert.deepEqual(await recovered.settle(committed.id), committed);
    assert.equal(await publicClient.getTransactionCount({ address: account.address }), nonce);
    const [, batch] = await publicClient.readContract({ address: manifest.game, abi: built.abi, functionName: 'plays', args: [committed.id] });
    const [sequence] = await publicClient.readContract({ address: manifest.game, abi: built.abi, functionName: 'randomness', args: [batch] });
    await write(MAINNET.entropy, dice.abi, 'fulfill', [sequence, zeroHash]);
    const settled = await recovered.settle(committed.id); assert(settled.outcomeId > 0);
    await recovered.redeem(settled.outcomeId, 1n);
    assert.equal((await recovered.read()).rfBalance, 40n + definition.outcomes[settled.outcomeId - 1].reward);
    assert.equal(await publicClient.readContract({ address: MAINNET.rf, abi: rf.abi, functionName: 'balanceOf', args: [canonical] }), 40n + definition.outcomes[settled.outcomeId - 1].reward);
  } finally { const stopped = new Promise(done => node.once('exit', done)); node.kill('SIGTERM'); await stopped; }
});
