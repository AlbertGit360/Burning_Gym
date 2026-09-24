import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { createChanceGameTransport } from '../dist/chain.js';
import { parseChanceGame } from '../dist/game.js';
import { CHAIN, MAINNET, ROOT, equal } from '../scripts/contracts/common.mjs';
import { deployGame, fundDeployment, preflight } from '../scripts/contracts/deploy.mjs';
import { resolvePlay } from '../scripts/contracts/resolve.mjs';
import { playOnce } from '../scripts/contracts/play.mjs';

// Public Anvil fixture mnemonic; never a real wallet. Every RPC in this test is loopback.
const LOCAL_TEST_MNEMONIC = 'test '.repeat(11) + 'junk';
const RF = 10n ** 18n;
const MOCK_PATH = resolve(ROOT, 'contracts/out/ChanceGame.t.sol');
const GAME_PATH = resolve(ROOT, 'contracts/out/ChanceGame.sol/ChanceGame.json');
const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
const hasArtifacts = existsSync(GAME_PATH) && ['MockRF', 'MockGenerations', 'MockDice']
  .every(name => existsSync(resolve(MOCK_PATH, `${name}.json`)));

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

const load = async path => JSON.parse(await readFile(path, 'utf8'));
const delay = ms => new Promise(done => setTimeout(done, ms));

function legendWord(game, batchId, playId) {
  let word = 0n;
  while (BigInt(keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  ], [toHex(word, { size: 32 }), game, BigInt(MAINNET.chainId), batchId, playId]))) % 10_000n < 9800n) word++;
  return toHex(word, { size: 32 });
}

test('local Anvil: deploy/resume without an NFT, then canonical wallet play, Dice resume and redemption', {
  skip: !hasAnvil ? 'Install Foundry/Anvil to run local contract integration.'
    : !hasArtifacts ? 'Run npm run build:contracts to compile local contract fixtures.' : false,
  timeout: 60_000,
}, async () => {
  const port = await unusedPort();
  const rpc = `http://127.0.0.1:${port}`;
  const chain = defineChain({ ...CHAIN, rpcUrls: { default: { http: [rpc] } } });
  const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(MAINNET.chainId), '--silent'], { stdio: 'ignore' });
  let processError;
  node.on('error', error => { processError = error; });
  const account = mnemonicToAccount(LOCAL_TEST_MNEMONIC);
  const secondAccount = mnemonicToAccount(LOCAL_TEST_MNEMONIC, { addressIndex: 1 });
  const transport = http(rpc, { retryCount: 0, timeout: 1000 });
  const client = createPublicClient({ chain, transport, pollingInterval: 10, cacheTime: 0 });
  const wallet = createWalletClient({ account, chain, transport, cacheTime: 0 });
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (processError) throw processError;
      if (node.exitCode !== null) throw new Error(`Local Anvil exited with code ${node.exitCode}.`);
      try { assert.equal(await client.getChainId(), MAINNET.chainId); break; }
      catch (error) { if (Date.now() > deadline) throw error; await delay(25); }
    }
    const [built, rfMock, generationsMock, diceMock, definitionJson] = await Promise.all([
      load(GAME_PATH), load(resolve(MOCK_PATH, 'MockRF.json')),
      load(resolve(MOCK_PATH, 'MockGenerations.json')), load(resolve(MOCK_PATH, 'MockDice.json')),
      load(resolve(ROOT, 'examples/fishing/game.json')),
    ]);
    const definition = parseChanceGame(definitionJson);
    const write = async (address, abi, functionName, args = []) => {
      const hash = await wallet.writeContract({ address, abi, functionName, args });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
      return receipt;
    };
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
    for (const [address, fixture, args] of [
      [MAINNET.rf, rfMock, []], [MAINNET.generations, generationsMock, [MAINNET.rf]],
      [MAINNET.entropy, diceMock, [MAINNET.provider]],
    ]) {
      const hash = await wallet.deployContract({ abi: fixture.abi, bytecode: fixture.bytecode.object, args });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
      const runtime = await client.getCode({ address: receipt.contractAddress });
      await client.request({ method: 'anvil_setCode', params: [address, runtime] });
    }
    await write(MAINNET.rf, rfMock.abi, 'mint', [account.address, 100n * RF]);
    // No NFT exists yet: deployment and its prize funding are independent of play eligibility.
    assert.equal(await read(MAINNET.generations, generationsMock.abi, 'ownerOf', [1n]), zeroAddress);
    const funding = await preflight(client, account.address, 10n * RF);
    assert.equal(funding.balance, 100n * RF);
    const saves = [];
    const save = async manifest => { saves.push(structuredClone(manifest)); };
    const manifest = await deployGame({ client, wallet, account, definition, built, initialStake: 10n * RF, save });
    assert.equal(manifest.status, 'deployed');
    assert.equal(saves[0].transactions[0].status, 'submitted');
    await fundDeployment({ client, wallet, account, abi: built.abi, manifest, save });
    assert.equal(manifest.status, 'funded');
    assert.deepEqual(manifest.transactions.map(tx => [tx.step, tx.status]), [
      ['deploy', 'confirmed'], ['approval', 'confirmed'], ['fund', 'confirmed'],
    ]);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [account.address]), 90n * RF);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [manifest.game]), 10n * RF);
    assert.equal(await read(MAINNET.generations, generationsMock.abi, 'ownerOf', [1n]), zeroAddress);
    for (const value of [...saves, manifest]) {
      assert.equal(Object.hasOwn(value, 'friendId'), false);
      assert.equal(Object.hasOwn(value, 'friendWallet'), false);
    }

    // Resume after a submitted funding hash was saved but confirmation was interrupted.
    manifest.transactions.find(tx => tx.step === 'fund').status = 'submitted';
    const nonceBeforeResume = await client.getTransactionCount({ address: account.address });
    await fundDeployment({ client, wallet, account, abi: built.abi, manifest, save });
    await fundDeployment({ client, wallet, account, abi: built.abi, manifest, save });
    assert.equal(await client.getTransactionCount({ address: account.address }), nonceBeforeResume);
    assert.equal(manifest.transactions.filter(tx => tx.step === 'fund').length, 1);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [manifest.game]), 10n * RF);
    assert.equal(await read(MAINNET.generations, generationsMock.abi, 'ownerOf', [1n]), zeroAddress);

    // Owned hardwired identity remains mandatory for the separate player phase.
    await write(MAINNET.generations, generationsMock.abi, 'mint', [account.address, 1n, 1]);
    const friendWallet = await read(MAINNET.generations, generationsMock.abi, 'tokenBoundAccount', [1n]);
    await write(MAINNET.rf, rfMock.abi, 'mint', [friendWallet, 3n * RF]);

    const deployment = { chainId: MAINNET.chainId, game: manifest.game, generations: MAINNET.generations, rf: MAINNET.rf };
    const host = createChanceGameTransport({ deployment, account: account.address, publicClient: client, walletClient: wallet });
    const initial = await host.read(1n);
    assert.equal(initial.mode, 'chain');
    assert.ok(initial.canControl);
    assert.ok(equal(initial.payer, friendWallet));
    assert.equal(initial.payerRF, 3n * RF);
    assert.equal(initial.freeStake, 10n * RF);
    const approval = await host.approvePurchase(1n, 1n);
    assert.equal(approval.amount, RF);
    const purchase = await host.buy(1n, 1n);
    assert.equal(purchase.payment, RF);
    assert.ok(equal(purchase.payer, friendWallet));
    const bought = await host.read(1n);
    assert.equal(bought.reservedPlays, 10n * RF);
    assert.equal(bought.freeStake, RF);
    assert.equal(bought.payerRF, 2n * RF);
    assert.equal(bought.consumables, 1n);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [account.address]), 90n * RF);
    const commitment = await host.play(1n, 1n);
    assert.equal(commitment.plays.length, 1);
    const { playId, batchId } = commitment.plays[0];
    const committed = await host.read(1n);
    assert.equal(committed.consumables, 0n);
    assert.equal(committed.reservedPlays, 10n * RF);

    const oracleTransactions = [];
    const resolution = { client, wallet, account, abi: built.abi, manifest, playId, waitMs: 0,
      onHash: hash => oracleTransactions.push(hash) };
    const pending = await resolvePlay(resolution);
    assert.equal(pending.pending, true);
    assert.equal(oracleTransactions.length, 1);
    const oraclePaid = await client.getBalance({ address: MAINNET.entropy });
    assert.equal(oraclePaid, funding.fee);
    const repeatedPending = await resolvePlay(resolution);
    assert.equal(repeatedPending.sequenceNumber, pending.sequenceNumber);
    assert.equal(oracleTransactions.length, 1);
    assert.equal(await client.getBalance({ address: MAINNET.entropy }), oraclePaid);

    // Mock delivery is explicit; this test does not claim to verify a live oracle operator.
    await write(MAINNET.entropy, diceMock.abi, 'fulfill', [pending.sequenceNumber, legendWord(manifest.game, batchId, playId)]);
    const settled = await resolvePlay(resolution);
    assert.equal(settled.outcomeId, 8n);
    assert.equal(oracleTransactions.length, 2);
    const settledAgain = await resolvePlay(resolution);
    assert.equal(settledAgain.alreadySettled, true);
    assert.equal(oracleTransactions.length, 2);
    const kept = await host.read(1n);
    assert.equal(kept.reservedPlays, 0n);
    assert.equal(kept.rewardLiability, 10n * RF);
    assert.equal(kept.outcomes[7].quantity, 1n);
    assert.equal((await host.readPlay(playId)).outcomeId, 8n);

    // The inventory stays in the canonical wallet after its NFT changes controller.
    await write(MAINNET.generations, generationsMock.abi, 'transfer', [1n, secondAccount.address]);
    assert.equal((await host.read(1n)).canControl, false);
    await assert.rejects(host.redeem(1n, 8n, 1n), /revert/i);
    const secondWallet = createWalletClient({ account: secondAccount, chain, transport, cacheTime: 0 });
    const newOwnerHost = createChanceGameTransport({ deployment, account: secondAccount.address, publicClient: client, walletClient: secondWallet });
    const redemption = await newOwnerHost.redeem(1n, 8n, 1n);
    assert.equal(redemption.payment, 10n * RF);
    const redeemed = await newOwnerHost.read(1n);
    assert.equal(redeemed.payerRF, 12n * RF);
    assert.equal(redeemed.rewardLiability, 0n);
    assert.equal(redeemed.freeStake, RF);
    assert.equal(redeemed.outcomes[7].quantity, 0n);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [account.address]), 90n * RF);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [secondAccount.address]), 0n);

    // Exercise the terminal flow with the transferred NFT and an empty canonical wallet.
    const walletAbi = parseAbi(['function execute(address,uint256,bytes,uint8) payable returns (bytes)']);
    const emptyWallet = await secondWallet.writeContract({ address: friendWallet, abi: walletAbi,
      functionName: 'execute', args: [MAINNET.rf, 0n,
        encodeFunctionData({ abi: rfMock.abi, functionName: 'transfer', args: [account.address, 12n * RF] }), 0] });
    assert.equal((await client.waitForTransactionReceipt({ hash: emptyWallet })).status, 'success');
    await write(MAINNET.rf, rfMock.abi, 'approve', [manifest.game, 9n * RF]);
    await write(manifest.game, built.abi, 'fund', [9n * RF]);
    const playContext = { client, wallet: secondWallet, account: secondAccount, abi: built.abi,
      manifest, friendId: 1n, manifestPath: '/local-anvil-only/fishing.json' };
    const nonceBeforeDeniedPlay = await client.getTransactionCount({ address: secondAccount.address });
    await assert.rejects(playOnce(playContext, async () => { throw new Error('Unexpected confirmation'); }),
      /needs enough RF to top up/);
    assert.equal(await client.getTransactionCount({ address: secondAccount.address }), nonceBeforeDeniedPlay);

    await write(MAINNET.rf, rfMock.abi, 'mint', [secondAccount.address, 2n * RF]);
    await assert.rejects(playOnce(playContext, async () => ''), /Cancelled before broadcasting/);
    assert.equal(await client.getTransactionCount({ address: secondAccount.address }), nonceBeforeDeniedPlay);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [friendWallet]), 0n);

    const prompts = [];
    const completeDraw = async context => {
      const pendingDraw = await resolvePlay({ ...context, waitMs: 0, onHash: () => {} });
      assert.equal(pendingDraw.pending, true);
      await write(MAINNET.entropy, diceMock.abi, 'fulfill', [pendingDraw.sequenceNumber,
        legendWord(manifest.game, pendingDraw.batchId, pendingDraw.playId)]);
      return resolvePlay({ ...context, waitMs: 0, onHash: () => {} });
    };
    await playOnce(playContext, async prompt => {
      prompts.push(prompt);
      return prompts.length === 1 ? 'PLAY' : 'REDEEM';
    }, completeDraw);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Type PLAY/);
    assert.match(prompts[1], /Type REDEEM/);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [secondAccount.address]), RF);
    assert.equal(await read(MAINNET.rf, rfMock.abi, 'balanceOf', [friendWallet]), 10n * RF);
    assert.equal(await read(manifest.game, built.abi, 'playCount'), 2n);
    assert.equal(await read(manifest.game, built.abi, 'reservedPlays'), 0n);
    assert.equal(await read(manifest.game, built.abi, 'rewardLiability'), 0n);
    assert.equal(await read(manifest.game, built.abi, 'freeStake'), RF);
    assert.equal((await newOwnerHost.read(1n)).outcomes[7].quantity, 0n);
  } finally {
    if (node.exitCode === null) {
      const stopped = new Promise(done => node.once('exit', done));
      node.kill('SIGTERM');
      await stopped;
    }
  }
});
