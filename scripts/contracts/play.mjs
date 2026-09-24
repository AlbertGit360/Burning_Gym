import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatEther, formatUnits, parseAbi, parseEventLogs } from 'viem';
import { createChanceGameTransport } from '../../dist/chain.js';
import { MAINNET, ENTROPY_ABI, equal, uint, ask, signingClients, loadManifest, artifact,
  verifyGame, sendContract, validateArgs, reportError } from './common.mjs';
import { resolvePlay } from './resolve.mjs';

const TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

async function main(args) {
  validateArgs(args);
  if (args.length < 1 || args.length > 2 || args.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: npm run play:contracts -- manifest.json [friendId]');
  }
  const manifestPath = resolve(args[0]);
  const manifest = await loadManifest(manifestPath);
  const friendId = uint(args[1] ?? await ask('Your hardwired Generations NFT token ID: '), 'Friend ID');
  const { abi } = await artifact();
  const { client, wallet, account } = await signingClients();
  return playOnce({ client, wallet, account, abi, manifest, friendId, manifestPath });
}

/** The terminal flow, also exercised with real transactions on the local test chain. */
export async function playOnce({ client, wallet, account, abi, manifest, friendId, manifestPath },
  confirm = ask, resolveCommitted = resolvePlay) {
  await verifyGame(client, abi, manifest);
  const transport = createChanceGameTransport({ deployment: manifest, account: account.address,
    publicClient: client, walletClient: wallet });
  const before = await transport.read(friendId);
  if (!before.canControl) throw new Error('The signing account must own this hardwired Generations NFT.');
  const buy = before.consumables === 0n;
  if (buy && before.freeStake < before.maxPrize) throw new Error('The game needs more free RF stake before it can sell a consumable.');
  const topUp = buy && before.payerRF < before.price ? before.price - before.payerRF : 0n;
  if (topUp > 0n) {
    const available = await client.readContract({ address: manifest.rf, abi: TOKEN_ABI,
      functionName: 'balanceOf', args: [account.address] });
    if (available < topUp) throw new Error('Your account needs enough RF to top up the Friend wallet for one purchase.');
  }
  const fee = await client.readContract({ address: MAINNET.entropy, abi: ENTROPY_ABI,
    functionName: 'getFeeV2', args: [MAINNET.provider, 200_000] });
  console.log(`Robinhood mainnet (${MAINNET.chainId}) · real transactions\nGame: ${manifest.game}\nFriend #${friendId}: ${before.recipient}`);
  console.log(`Friend wallet: ${formatUnits(before.payerRF, 18)} RF; ${before.consumables} consumable(s).`);
  console.log(buy ? `Buy one consumable for ${formatUnits(before.price, 18)} RF from the Friend wallet.` : 'Use one previously purchased consumable.');
  if (topUp > 0n) console.log(`First transfer ${formatUnits(topUp, 18)} RF from ${account.address} to the Friend wallet.`);
  console.log(`Then play once, sponsor Dice (${formatEther(fee)} ETH at the current quote), and settle. Transactions also cost ETH gas.`);
  if (await confirm('Type PLAY to send these mainnet transactions: ') !== 'PLAY') throw new Error('Cancelled before broadcasting.');

  if (topUp > 0n) {
    const current = await transport.read(friendId);
    if (!current.canControl || !equal(current.recipient, before.recipient)) throw new Error('Friend ownership or wallet changed.');
    const confirmed = await sendContract({ client, wallet, account, address: manifest.rf,
      abi: TOKEN_ABI, functionName: 'transfer', args: [before.recipient, topUp],
      onHash: hash => console.log(`Friend wallet top-up submitted: ${hash}`) });
    const events = parseEventLogs({ abi: TOKEN_ABI, eventName: 'Transfer', strict: true,
      logs: confirmed.logs.filter(log => equal(log.address, manifest.rf)) });
    if (!events.some(event => equal(event.args.from, account.address) && equal(event.args.to, before.recipient) && event.args.value === topUp)) {
      throw new Error(`Top-up receipt ${confirmed.transactionHash} did not match the requested transfer.`);
    }
  }
  if (buy) {
    console.log(`RF approval confirmed: ${(await transport.approvePurchase(friendId, 1n)).transactionHash}`);
    console.log(`Purchase confirmed: ${(await transport.buy(friendId, 1n)).transactionHash}`);
  }
  const committed = await transport.play(friendId, 1n);
  const playId = committed.plays[0].playId;
  console.log(`Play ${playId} committed: ${committed.transactionHash}`);
  const quotedManifest = "'" + manifestPath.replaceAll("'", "'\\''") + "'";
  console.log(`Recover this same play if interrupted: npm run resolve:contracts -- ${quotedManifest} ${playId}`);
  const result = await resolveCommitted({ client, wallet, account, abi, manifest, playId, maxOracleFee: fee });
  if (result.pending) {
    console.log(`Dice request ${result.sequenceNumber} is pending. Use the recovery command later; this play stays backed.`);
    return;
  }
  const snapshot = await transport.read(friendId);
  const outcome = snapshot.outcomes.find(value => value.id === result.outcomeId);
  console.log(`Confirmed outcome ${result.outcomeId}: ${formatUnits(outcome.reward, 18)} RF redemption value. Kept in your Friend wallet.`);
  if (outcome.reward > 0n && await confirm('Type REDEEM to sell one of this outcome now, or Enter to keep it: ') === 'REDEEM') {
    console.log(`Redemption confirmed: ${(await transport.redeem(friendId, result.outcomeId, 1n)).transactionHash}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    if (error?.transactionHash) console.error(`Inspect transaction before retrying: ${error.transactionHash}`);
    reportError(error);
  });
}
