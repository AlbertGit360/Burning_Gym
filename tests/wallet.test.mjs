import test from "node:test";
import assert from "node:assert/strict";
import { createFriendWalletSession, createFriendPublicClient } from "../dist/wallet.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const NEXT_OWNER = "0x2222222222222222222222222222222222222222";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function wallet() {
  const events = new Map();
  const state = { accounts: [OWNER], chainId: "0x1237", requests: [], overrides: {} };
  const provider = {
    request({ method, params }) {
      state.requests.push(method);
      if (state.overrides[method]) return state.overrides[method](params);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return Promise.resolve(state.accounts);
      if (method === "eth_chainId") return Promise.resolve(state.chainId);
      throw new Error(`Unexpected wallet request: ${method}`);
    },
    on(event, listener) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event).add(listener);
    },
    removeListener(event, listener) { events.get(event)?.delete(listener); },
  };
  return { state, provider, emit: (event, ...args) => { for (const listener of events.get(event) ?? []) listener(...args); },
    listenerCount: () => [...events.values()].reduce((sum, set) => sum + set.size, 0) };
}
function announce(target, provider, uuid, name) {
  target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
    provider, info: { uuid, name, rdns: "test.wallet", icon: "data:image/svg+xml,<svg/>" },
  } }));
}

test("wallet restoration is read-only and snapshots remain stable until changes", async () => {
  const w = wallet();
  const session = createFriendWalletSession({ provider: w.provider });
  assert.equal(session.getSnapshot().status, "connecting");
  assert.equal(session.getSnapshot().account, null);
  await tick();
  assert.equal(session.getSnapshot().status, "connected");
  assert.equal(session.getSnapshot().chainId, 4663);
  assert.equal(session.getSnapshot().account, OWNER);
  assert.deepEqual(w.state.requests, ["eth_accounts", "eth_chainId"]);
  assert.strictEqual(session.getSnapshot(), session.getSnapshot());
  assert(Object.isFrozen(session.getSnapshot()));
  assert(Object.isFrozen(session.getSnapshot().wallets));
  assert(Object.isFrozen(session.getSnapshot().wallets[0]));
  await session.connect();
  assert.deepEqual(w.state.requests.slice(-2), ["eth_requestAccounts", "eth_chainId"]);
  session.dispose();
});

test("unsupported networks block connected status, malformed networks fail closed", async () => {
  const w = wallet();
  w.state.chainId = "0x1";
  const session = createFriendWalletSession({ provider: w.provider });
  await tick();
  assert.equal(session.getSnapshot().status, "wrong-network");
  assert.equal(session.getSnapshot().chainId, 1);
  w.state.chainId = "4663";
  await session.refresh();
  assert.equal(session.getSnapshot().status, "error");
  assert.equal(session.getSnapshot().account, null);
  assert.match(session.getSnapshot().error, /invalid network/);
  w.state.accounts = ["not-an-address"];
  await session.refresh();
  assert.equal(session.getSnapshot().status, "error");
  assert.match(session.getSnapshot().error, /invalid account/);
  session.dispose();
});

test("account and chain changes invalidate synchronously before fresh reads resolve", async () => {
  const w = wallet();
  const session = createFriendWalletSession({ provider: w.provider });
  await tick();
  const old = session.getSnapshot();
  const pending = deferred();
  w.state.overrides.eth_accounts = () => pending.promise;
  w.emit("accountsChanged", [NEXT_OWNER]);
  assert.equal(session.getSnapshot().account, null);
  assert.equal(session.getSnapshot().status, "connecting");
  assert(session.getSnapshot().revision > old.revision);
  pending.resolve([NEXT_OWNER]);
  await tick();
  assert.equal(session.getSnapshot().account, NEXT_OWNER);
  w.state.chainId = "0x1";
  w.emit("chainChanged", "0x1");
  assert.equal(session.getSnapshot().account, null);
  await tick();
  assert.equal(session.getSnapshot().status, "wrong-network");
  session.dispose();
});

test("disconnect prevents an in-flight connection from restoring identity", async () => {
  const w = wallet();
  const session = createFriendWalletSession({ provider: w.provider });
  await tick();
  const pending = deferred();
  w.state.overrides.eth_requestAccounts = () => pending.promise;
  const connection = session.connect();
  w.emit("disconnect", { code: 4900 });
  assert.equal(session.getSnapshot().status, "disconnected");
  assert.equal(session.getSnapshot().account, null);
  pending.resolve([OWNER]);
  await connection;
  assert.equal(session.getSnapshot().status, "disconnected");
  assert.equal(session.getSnapshot().account, null);
  session.dispose();
});

test("selecting another discovered wallet fences old connections and detaches its events", async () => {
  const target = new EventTarget();
  const first = wallet(), second = wallet();
  second.state.accounts = [NEXT_OWNER];
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  target.addEventListener("eip6963:requestProvider", () => {
    announce(target, first.provider, a, "First wallet");
    announce(target, second.provider, b, "Second wallet");
  });
  const session = createFriendWalletSession({ target });
  await tick();
  assert.deepEqual(session.getSnapshot().wallets, [{ id: a, name: "First wallet" }, { id: b, name: "Second wallet" }]);
  const pending = deferred();
  first.state.overrides.eth_requestAccounts = () => pending.promise;
  const staleConnection = session.connect(a);
  const snapshots = [];
  session.subscribe(() => snapshots.push(session.getSnapshot()));
  await session.connect(b);
  assert(snapshots.every(snapshot => snapshot.selectedWalletId !== b || snapshot.account !== OWNER));
  assert.equal(session.getSnapshot().account, NEXT_OWNER);
  assert.equal(first.listenerCount(), 0);
  first.emit("disconnect", { code: 4900 });
  pending.resolve([OWNER]);
  await staleConnection;
  assert.equal(session.getSnapshot().account, NEXT_OWNER);
  assert.equal(session.getSnapshot().selectedWalletId, b);
  session.dispose();
});

test("discovery names injected wallets once and local disconnect survives late discovery", async () => {
  const target = new EventTarget();
  const first = wallet(), late = wallet();
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  target.ethereum = first.provider;
  target.addEventListener("eip6963:requestProvider", () => announce(target, first.provider, id, "Named wallet"));
  const session = createFriendWalletSession({ target });
  await tick();
  assert.deepEqual(session.getSnapshot().wallets, [{ id, name: "Named wallet" }]);
  assert.equal(session.getSnapshot().selectedWalletId, id);
  session.disconnect();
  announce(target, late.provider, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Late wallet");
  await tick();
  assert.equal(session.getSnapshot().status, "disconnected");
  assert.equal(session.getSnapshot().account, null);
  assert.equal(session.getSnapshot().selectedWalletId, null);
  assert.equal(first.listenerCount(), 0);
  assert.deepEqual(late.state.requests, []);
  session.dispose();
});

test("a supplied provider reuses the project's connection without discovering another flow", async () => {
  const target = new EventTarget();
  const supplied = wallet(), injected = wallet();
  target.ethereum = injected.provider;
  let discoveryRequests = 0;
  target.addEventListener("eip6963:requestProvider", () => discoveryRequests++);
  const session = createFriendWalletSession({ target, provider: supplied.provider });
  await tick();
  await session.connect();
  assert.equal(discoveryRequests, 0);
  assert.deepEqual(injected.state.requests, []);
  assert.equal(session.getSnapshot().wallets.length, 1);
  session.dispose();
});

test("disposal cancels pending identity, subscriptions and all provider listeners", async () => {
  const w = wallet(), pending = deferred();
  w.state.overrides.eth_accounts = () => pending.promise;
  const session = createFriendWalletSession({ provider: w.provider });
  let notifications = 0;
  session.subscribe(() => notifications++);
  session.dispose();
  pending.resolve([OWNER]);
  await tick();
  assert.equal(session.getSnapshot().account, null);
  assert.equal(session.getSnapshot().status, "unavailable");
  assert.equal(w.listenerCount(), 0);
  assert.equal(notifications, 0);
  await session.connect();
  assert.deepEqual(w.state.requests, ["eth_accounts"]);
});

test("missing wallets and rejected connection provide recoverable states without signatures", async () => {
  const missing = createFriendWalletSession({ target: new EventTarget() });
  await missing.connect();
  assert.equal(missing.getSnapshot().status, "unavailable");
  assert.match(missing.getSnapshot().error, /wallet-enabled browser/);
  missing.dispose();
  const w = wallet();
  w.state.accounts = [];
  const session = createFriendWalletSession({ provider: w.provider });
  await tick();
  assert.equal(session.getSnapshot().status, "disconnected");
  w.state.overrides.eth_requestAccounts = () => Promise.reject({ code: 4001 });
  await session.connect();
  assert.equal(session.getSnapshot().status, "error");
  assert.match(session.getSnapshot().error, /declined/);
  delete w.state.overrides.eth_requestAccounts;
  w.state.accounts = [OWNER];
  await session.connect();
  assert.equal(session.getSnapshot().status, "connected");
  assert(w.state.requests.every(method => ["eth_accounts", "eth_requestAccounts", "eth_chainId"].includes(method)));
  session.dispose();
});

test("the default public client requires neither a key nor a wallet transport", () => {
  const client = createFriendPublicClient();
  assert.equal(client.transport.type, "http");
  assert.equal(client.transport.url, "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(client.account, undefined);
  assert.equal(client.cacheTime, 0);
  assert.equal(client.sendTransaction, undefined);
});

test('network switch is explicit, uses pinned chain, and rereads a wallet without events', async () => {
  const w = wallet(); w.state.chainId = '0x1';
  const session = createFriendWalletSession({ provider: w.provider });
  await tick();
  assert(!w.state.requests.includes('wallet_switchEthereumChain'));
  const pending = deferred();
  w.state.overrides.wallet_switchEthereumChain = async params => {
    assert.deepEqual(params, [{ chainId: '0x1237' }]);
    await pending.promise; w.state.chainId = '0x1237';
  };
  const oldRevision = session.getSnapshot().revision;
  const switching = session.switchNetwork();
  assert.equal(session.getSnapshot().status, 'switching-network');
  assert.equal(session.getSnapshot().account, null);
  assert(session.getSnapshot().revision > oldRevision);
  await session.switchNetwork();
  assert.equal(w.state.requests.filter(method => method === 'wallet_switchEthereumChain').length, 1);
  pending.resolve(); await switching;
  assert.equal(session.getSnapshot().status, 'connected');
  assert.equal(session.getSnapshot().account, OWNER);
  session.dispose();
});

test('unknown network is added with official settings then explicitly selected', async () => {
  const w = wallet(); w.state.chainId = '0x1';
  const session = createFriendWalletSession({ provider: w.provider }); await tick();
  let switches = 0;
  w.state.overrides.wallet_switchEthereumChain = () => {
    if (++switches === 1) throw { code: 4902 };
    w.state.chainId = '0x1237';
  };
  w.state.overrides.wallet_addEthereumChain = params => {
    assert.deepEqual(params, [{ chainId: '0x1237', chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
      blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] }]);
  };
  await session.switchNetwork();
  assert.equal(switches, 2);
  assert.equal(session.getSnapshot().status, 'connected');
  session.dispose();
});

test('declined and unsupported switches remain retryable; success never assumes chain changed', async () => {
  for (const code of [4001, 4200, -32002]) {
    const w = wallet(); w.state.chainId = '0x1';
    const session = createFriendWalletSession({ provider: w.provider }); await tick();
    w.state.overrides.wallet_switchEthereumChain = () => { throw { code }; };
    await session.switchNetwork();
    assert.equal(session.getSnapshot().status, 'wrong-network');
    assert.match(session.getSnapshot().error, code === 4001 ? /declined/ : code === -32002 ? /pending/ : /select Robinhood/);
    assert(!w.state.requests.includes('wallet_addEthereumChain'));
    w.state.overrides.wallet_switchEthereumChain = () => null;
    await session.switchNetwork();
    assert.equal(session.getSnapshot().status, 'wrong-network');
    session.dispose();
  }
});

test('network-switch completion cannot revive disconnected, disposed or changed sessions', async () => {
  for (const event of ['disconnect', 'dispose', 'accountsChanged', 'chainChanged']) {
    const w = wallet(); w.state.chainId = '0x1';
    const session = createFriendWalletSession({ provider: w.provider }); await tick();
    const pending = deferred();
    w.state.overrides.wallet_switchEthereumChain = () => pending.promise;
    const switching = session.switchNetwork();
    if (event === 'disconnect') session.disconnect();
    else if (event === 'dispose') session.dispose();
    else if (event === 'accountsChanged') { w.state.accounts = [NEXT_OWNER]; w.emit(event, [NEXT_OWNER]); }
    else { w.state.chainId = '0x1237'; w.emit(event, '0x1237'); }
    await tick();
    const snapshot = session.getSnapshot();
    pending.reject({ code: 4902 }); await switching;
    assert.strictEqual(session.getSnapshot(), snapshot);
    assert(!w.state.requests.includes('wallet_addEthereumChain'));
    session.dispose();
  }
});
