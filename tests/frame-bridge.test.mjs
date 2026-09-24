import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequestError } from 'viem';
import { bindGameFrame, createFrameGameClient } from '../dist/frame-bridge.js';
import { createGamePreview, RF } from '../dist/game.js';

const definition = { name: 'Test', consumable: 'Bait', price: RF, outcomes: [{ name: 'Fish', chanceBps: 10000, reward: 2n * RF }] };
function setup(authorize = async () => {}) {
  const { port1, port2 } = new MessageChannel();
  const preview = createGamePreview(definition, { stake: 10n * RF, rfBalance: 20n * RF, friendId: 5n, draw: () => 0 });
  const host = bindGameFrame(port1, { client: preview.client, authorize });
  const frame = createFrameGameClient(port2, definition);
  return { host, frame, preview, port2, close: () => { host.close(); frame.close(); } };
}
test('private frame actions require host approval and stay bound to its Friend', async () => {
  const approvals = [];
  const session = setup(async (method, args) => approvals.push([method, ...args]));
  try {
    assert.equal((await session.frame.client.read()).friendId, 5n);
    await session.frame.client.buy(1n);
    const [play] = await session.frame.client.play();
    await session.frame.client.settle(play.id);
    await session.frame.client.redeem(1, 1n);
    assert.equal((await session.frame.client.read()).rfBalance, 21n * RF);
    assert.deepEqual(approvals, [['buy', 1n], ['play', 1n], ['redeem', 1, 1n]]);
  } finally { session.close(); }
});
test('rejected confirmations and invalid quantities do not change a ledger', async () => {
  const session = setup(async () => { throw new Error('Cancelled'); });
  try {
    await assert.rejects(session.frame.client.buy(1n), /Cancelled/);
    for (const quantity of [0n, -1n, 100n, '1', 1]) await assert.rejects(session.frame.client.buy(quantity), /Unsupported/);
    assert.equal((await session.preview.client.read()).rfBalance, 20n * RF);
  } finally { session.close(); }
});
test('closing a session while confirmation waits prevents a later approval from spending', async () => {
  let approve, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const session = setup(() => { entered(); return new Promise(resolve => { approve = resolve; }); });
  try {
    const purchase = session.frame.client.buy(1n);
    const rejected = assert.rejects(purchase, /session changed/);
    await ready; session.host.close(); approve();
    await rejected;
    assert.equal((await session.preview.client.read()).consumables, 0n);
  } finally { session.close(); }
});
test('host menus pause new spending and a pending confirmation cannot be flooded', async () => {
  let approve, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const session = setup(() => { entered(); return new Promise(resolve => { approve = resolve; }); });
  try {
    session.host.setPaused(true);
    await assert.rejects(session.frame.client.buy(1n), /Close the host menu/);
    session.host.setPaused(false);
    const purchase = session.frame.client.buy(1n);
    await ready;
    await assert.rejects(session.frame.client.buy(1n), /pending/);
    session.host.setPaused(true); approve(); await purchase;
    assert.equal((await session.preview.client.read()).consumables, 1n);
  } finally { session.close(); }
});
test('arbitrary transactions and caller-selected Friend IDs are not bridge methods', async () => {
  const session = setup();
  try {
    for (const [id, method, args] of [[1, 'eth_sendTransaction', [{}]], [2, 'buy', [1n, 999n]], [3, 'selectFriend', [999n]]]) {
      const response = new Promise(resolve => session.port2.addEventListener('message', event => resolve(event.data), { once: true }));
      session.port2.postMessage({ type: 'friendsdk:request', id, method, args });
      assert.match((await response).error, /Unsupported/);
    }
    assert.equal((await session.preview.client.read()).friendId, 5n);
  } finally { session.close(); }
});

test('live actions return their confirmed result without waiting for another state read', async () => {
  const { port1, port2 } = new MessageChannel();
  let reads = 0;
  const snapshots = [], approvals = [];
  const preview = createGamePreview(definition, { stake: 10n * RF, rfBalance: 20n * RF, friendId: 5n, draw: () => 0 });
  const client = { ...preview.client, mode: 'chain', async read() {
    reads++;
    throw new Error('State refresh unavailable');
  } };
  const host = bindGameFrame(port1, { client, authorize: async method => { approvals.push(method); }, onSnapshot: value => snapshots.push(value) });
  const frame = createFrameGameClient(port2, definition, undefined, 'chain');
  try {
    await frame.client.buy(1n);
    const [play] = await frame.client.play();
    assert.equal((await frame.client.settle(play.id)).outcomeId, 1);
    await frame.client.redeem(1, 1n);
    assert.equal(reads, 0, 'Receipt-confirmed actions must not trigger a redundant RPC refresh');
    assert.deepEqual(approvals, ['buy', 'play', 'settle', 'redeem']);
    assert.deepEqual(snapshots, []);
    await assert.rejects(frame.client.read(), /Could not read game state/);
    assert.equal(reads, 1);
  } finally { host.close(); frame.close(); }
});


test('private RPC and wallet diagnostics stay in the trusted host, never in the game response', async () => {
  const secret = 'AUDIT_PRIVATE_API_KEY', privateBody = 'AUDIT_PRIVATE_REQUEST_BODY';
  const errors = [
    new HttpRequestError({ url: `https://rpc.example.invalid/v1/${secret}`, body: { privateBody }, details: 'Fixture failure' }),
    new Error(`Wallet diagnostic: ${secret}; private request ${privateBody}`),
  ];
  for (const error of errors) {
    const { port1, port2 } = new MessageChannel(); const received = [];
    const client = { definition, mode: 'chain', read: async () => { throw error; }, buy: async () => { throw error; } };
    const host = bindGameFrame(port1, { client, authorize: async () => {}, onError: cause => received.push(cause) });
    const frame = createFrameGameClient(port2, definition);
    try {
      await assert.rejects(frame.client.read(), cause => {
        assert.equal(cause.message, 'Could not read game state. Retry the read.');
        assert(!cause.message.includes(secret)); assert(!cause.message.includes(privateBody)); return true;
      });
      await assert.rejects(frame.client.buy(1n), cause => {
        assert.match(cause.message, /Check your wallet and transaction status/);
        assert(!cause.message.includes(secret)); assert(!cause.message.includes(privateBody)); return true;
      });
      assert.deepEqual(received, [error, error], 'Original diagnostics remain available only to the trusted host');
    } finally { host.close(); frame.close(); }
  }
});

test('transaction recovery preserves only validated status and hash, never raw provider messages', async () => {
  const hash = `0x${'ab'.repeat(32)}`, secret = 'PRIVATE_PROVIDER_DIAGNOSTIC';
  for (const [code, transactionHash] of [['unconfirmed', hash], ['unverified', hash], ['replaced', hash], ['reorg', hash], ['reverted', hash], ['unconfirmed', secret], ['constructor', hash]]) {
    const { port1, port2 } = new MessageChannel();
    const error = Object.assign(new Error(secret), { name: 'ChanceTransactionError', code, transactionHash });
    const client = { definition, mode: 'chain', buy: async () => { throw error; } };
    const host = bindGameFrame(port1, { client, authorize: async () => {} });
    const frame = createFrameGameClient(port2, definition);
    try {
      await assert.rejects(frame.client.buy(1n), cause => {
        assert(!cause.message.includes(secret));
        if (transactionHash === hash && code !== 'constructor') { assert(cause.message.includes(hash)); assert.match(cause.message, /Inspect the transaction in your wallet before retrying/); }
        else assert.match(cause.message, /Game action failed/);
        return true;
      });
    } finally { host.close(); frame.close(); }
  }
});
