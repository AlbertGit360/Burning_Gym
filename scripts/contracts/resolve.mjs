import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatEther } from 'viem';
import { MAINNET, ENTROPY_ABI, uint, ask, signingClients, loadManifest, artifact,
  verifyGame, sendContract, validateArgs, reportError } from './common.mjs';

/** One committed play; reruns observe the existing request/result instead of buying a new draw. */
export async function resolvePlay({ client, wallet, account, abi, manifest, playId,
  onHash = hash => console.log(`Submitted: ${hash}`), waitMs = 120_000,
  maxOracleFee,
  sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const game = await verifyGame(client, abi, manifest);
  const read = (functionName, args) => client.readContract({ address: game, abi, functionName, args });
  let [friendId, batchId, outcomeId] = await read('plays', [playId]);
  if (batchId === 0n) throw new Error('Unknown play ID.');
  if (outcomeId !== 0n) return { playId, friendId, batchId, outcomeId, alreadySettled: true };
  let randomness = await read('randomness', [batchId]);
  if (!randomness[1]) {
    const fee = await client.readContract({ address: MAINNET.entropy, abi: ENTROPY_ABI,
      functionName: 'getFeeV2', args: [MAINNET.provider, 200_000] });
    if (maxOracleFee !== undefined && fee > maxOracleFee) throw new Error('Dice fee increased since confirmation. Review the new fee before retrying.');
    await sendContract({ client, wallet, account, address: game, abi, functionName: 'requestRandomness',
      args: [batchId], value: fee, onHash });
    randomness = await read('randomness', [batchId]);
    if (!randomness[1]) throw new Error('Receipt succeeded but the Dice request could not be verified.');
  }
  const deadline = Date.now() + waitMs;
  while (!randomness[2] && Date.now() < deadline) {
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
    randomness = await read('randomness', [batchId]);
  }
  if (!randomness[2]) return { playId, friendId, batchId, pending: true, sequenceNumber: randomness[0] };
  // Another caller may settle while Dice is fulfilling; this is the same immutable draw.
  [, , outcomeId] = await read('plays', [playId]);
  if (outcomeId !== 0n) return { playId, friendId, batchId, outcomeId, alreadySettled: true };
  const confirmed = await sendContract({ client, wallet, account, address: game, abi,
    functionName: 'settle', args: [playId], onHash });
  const result = await client.readContract({ address: game, abi, functionName: 'plays', args: [playId], blockNumber: confirmed.blockNumber });
  if (result[0] !== friendId || result[1] !== batchId || result[2] === 0n) throw new Error('Receipt succeeded but the settled play could not be verified.');
  return { playId, friendId, batchId, outcomeId: result[2], transactionHash: confirmed.transactionHash };
}

async function main(args) {
  validateArgs(args);
  if (args.length !== 2 || args.some(arg => arg.startsWith('--'))) throw new Error('Usage: npm run resolve:contracts -- manifest.json playId');
  const manifest = await loadManifest(resolve(args[0]));
  const playId = uint(args[1], 'Play ID');
  const { abi } = await artifact();
  const { client, wallet, account } = await signingClients();
  const game = await verifyGame(client, abi, manifest);
  const [friendId, batchId, outcomeId] = await client.readContract({ address: game, abi, functionName: 'plays', args: [playId] });
  if (batchId === 0n) throw new Error('Unknown play ID.');
  if (outcomeId !== 0n) { console.log(`Play ${playId} is already settled: outcome ${outcomeId}.`); return; }
  const [, requested] = await client.readContract({ address: game, abi, functionName: 'randomness', args: [batchId] });
  const fee = requested ? 0n : await client.readContract({ address: MAINNET.entropy, abi: ENTROPY_ABI, functionName: 'getFeeV2', args: [MAINNET.provider, 200_000] });
  console.log(`Network: Robinhood mainnet (${MAINNET.chainId})\nSigner: ${account.address}\nGame: ${game}\nFriend: ${friendId}\nPlay: ${playId}; batch: ${batchId}`);
  console.log(requested ? 'Dice request already exists; no additional oracle payment.' : `Dice request fee now: ${formatEther(fee)} ETH. Fee is re-quoted immediately before simulation.`);
  console.log('Oracle request and settlement cost ETH gas. No new purchase, reroll, or RF payment.');
  if (await ask('Type RESOLVE to sponsor Dice if needed and settle this play: ') !== 'RESOLVE') throw new Error('Cancelled before broadcasting.');
  console.log('Waiting up to two minutes for Dice fulfillment.');
  const result = await resolvePlay({ client, wallet, account, abi, manifest, playId, maxOracleFee: fee });
  if (result.pending) console.log(`Dice sequence ${result.sequenceNumber} is still pending. Rerun this command later; the existing request will be reused. Pending backing remains reserved.`);
  else console.log(`Confirmed play ${playId}: outcome ${result.outcomeId}${result.transactionHash ? `; transaction ${result.transactionHash}` : ' (already settled)'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(reportError);
