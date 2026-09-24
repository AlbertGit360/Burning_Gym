import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeDeployData, formatEther, formatUnits, parseEventLogs, parseUnits } from 'viem';
import { maximumPrize, parseChanceGame } from '../../dist/game.js';
import { ROOT, MAINNET, ERC20_ABI, GENERATIONS_ABI, ENTROPY_ABI, equal,
  uint, ask, signingClients, checkNetwork, receipt, saveManifest, loadManifest, artifact,
  verifyGame, sendContract, validateArgs, reportError } from './common.mjs';

export function constructorArgs(definition) {
  return [MAINNET.rf, MAINNET.generations, MAINNET.entropy, MAINNET.provider,
    definition.consumable, definition.consumable, definition.price,
    definition.outcomes.map(outcome => ({ chanceBps: outcome.chanceBps, reward: outcome.reward,
      metadataURI: `data:application/json;base64,${Buffer.from(JSON.stringify({ name: outcome.name,
        description: `${outcome.chanceBps}/10000 chance; ${formatUnits(outcome.reward, 18)} RF redemption.` })).toString('base64')}` }))];
}

export async function preflight(client, account, initialStake) {
  await checkNetwork(client);
  const blockNumber = await client.getBlockNumber();
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber });
  const codes = await Promise.all([MAINNET.generations, MAINNET.rf, MAINNET.entropy].map(address => client.getCode({ address, blockNumber })));
  if (codes.some(code => !code || code === '0x')) throw new Error('An existing Generations, RF, or Dice contract has no code on the selected chain.');
  const [rf, balance, decimals, eth, fee] = await Promise.all([
    read(MAINNET.generations, GENERATIONS_ABI, 'token'),
    read(MAINNET.rf, ERC20_ABI, 'balanceOf', [account]),
    read(MAINNET.rf, ERC20_ABI, 'decimals'), client.getBalance({ address: account, blockNumber }),
    read(MAINNET.entropy, ENTROPY_ABI, 'getFeeV2', [MAINNET.provider, 200_000]),
  ]);
  if (!equal(rf, MAINNET.rf) || decimals !== 18) throw new Error('Generations RF token does not match the pinned 18-decimal RF deployment.');
  if (balance < initialStake) throw new Error('The deployer RF balance does not cover the initial game stake.');
  if (eth === 0n) throw new Error('The deployer needs ETH for mainnet transactions.');
  return { balance, eth, fee };
}

/** Exported for integration tests; signers and clients are passed in, never serialized. */
export async function deployGame({ client, wallet, account, definition, built, initialStake, save }) {
  await checkNetwork(client);
  const manifest = { schemaVersion: 1, chainId: MAINNET.chainId, rf: MAINNET.rf,
    generations: MAINNET.generations, entropy: MAINNET.entropy, provider: MAINNET.provider,
    deployer: account.address,
    initialStake: initialStake.toString(), definition: JSON.parse(JSON.stringify(definition, (_, value) => typeof value === 'bigint' ? value.toString() : value)),
    status: 'deploying', transactions: [] };
  const hash = await wallet.deployContract({ account, chain: wallet.chain, abi: built.abi,
    bytecode: built.bytecode.object, args: constructorArgs(definition) });
  manifest.transactions.push({ step: 'deploy', hash, status: 'submitted' });
  console.log(`Deployment submitted: ${hash}`);
  await save(manifest);
  const confirmed = await receipt(client, hash);
  if (!confirmed.contractAddress) throw new Error('Confirmed deployment did not create a contract.');
  manifest.game = confirmed.contractAddress;
  manifest.transactions[0].status = 'confirmed';
  manifest.status = 'deployed';
  await save(manifest);
  return manifest;
}

export async function fundDeployment({ client, wallet, account, abi, manifest, save }) {
  if (!equal(account.address, manifest.deployer)) throw new Error('Resume with the original deployer account.');
  const game = await verifyGame(client, abi, manifest);
  const stake = uint(manifest.initialStake, 'Initial stake');
  const definition = parseChanceGame(manifest.definition);
  const [price, maxPrize] = await Promise.all(['price', 'maxPrize'].map(functionName => client.readContract({ address: game, abi, functionName })));
  if (price !== definition.price || maxPrize !== maximumPrize(definition) || stake < maxPrize) throw new Error('Manifest terms do not match the game or the stake is below its maximum prize.');
  async function step(name, address, stepAbi, functionName, args) {
    // A consumed/changed allowance requires a fresh approval, even after a prior successful one.
    let record = manifest.transactions.findLast(tx => tx.step === name && tx.status !== 'reverted' && (name !== 'approval' || tx.status !== 'confirmed'));
    let confirmed;
    if (record) {
      const observed = await client.waitForTransactionReceipt({ hash: record.hash, confirmations: 1, timeout: 120_000 });
      if (observed.status !== 'success') { record.status = 'reverted'; await save(manifest); throw new Error(`${name} reverted. Inspect ${record.hash}; rerun --resume to retry once corrected.`); }
      confirmed = await receipt(client, record.hash);
    } else {
      confirmed = await sendContract({ client, wallet, account, address, abi: stepAbi, functionName, args,
        onHash: async hash => {
          record = { step: name, hash, status: 'submitted' }; manifest.transactions.push(record);
          console.log(`${name} submitted: ${hash}`); await save(manifest);
        } });
    }
    if (!equal(confirmed.from, account.address) || !equal(confirmed.to, address)) throw new Error(`${name} receipt does not match the signing account and contract.`);
    const eventName = name === 'approval' ? 'Approval' : 'Funded';
    const events = parseEventLogs({ abi: stepAbi, eventName, logs: confirmed.logs.filter(log => equal(log.address, address)), strict: true });
    const matches = name === 'approval'
      ? events.some(event => equal(event.args.owner, account.address) && equal(event.args.spender, game) && event.args.value === stake)
      : events.some(event => equal(event.args.funder, account.address) && event.args.amount === stake);
    if (!matches) throw new Error(`${name} receipt is missing the matching ${eventName} event.`);
    record.status = 'confirmed'; await save(manifest);
  }
  const funded = manifest.transactions.findLast(tx => tx.step === 'fund' && tx.status !== 'reverted');
  if (!funded) {
    const balance = await client.readContract({ address: MAINNET.rf, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
    if (balance < stake) throw new Error('Deployer needs the initial RF stake before funding can resume.');
    const allowance = await client.readContract({ address: MAINNET.rf, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, game] });
    if (allowance !== stake) await step('approval', MAINNET.rf, ERC20_ABI, 'approve', [game, stake]);
  }
  await step('fund', game, abi, 'fund', [stake]);
  manifest.consumable = await client.readContract({ address: game, abi, functionName: 'consumable' });
  manifest.status = 'funded'; await save(manifest);
  return manifest;
}

async function main(args) {
  validateArgs(args);
  const resume = args[0] === '--resume';
  if ((resume && args.length !== 2) || (!resume && (args.length > 1 || args[0]?.startsWith('--')))) throw new Error('Usage: npm run deploy:contracts -- [game.json | --resume manifest.json]');
  console.log('Building local FriendSDK contracts. Existing Generations, RF, NFT wallets, and Dice contracts are reused.');
  execFileSync('forge', ['build', '--root', resolve(ROOT, 'contracts')], { stdio: 'inherit' });
  const built = await artifact();
  let manifest = resume ? await loadManifest(resolve(args[1])) : undefined;
  const definition = parseChanceGame(manifest?.definition ?? JSON.parse(await readFile(resolve(args[0] ?? resolve(ROOT, 'examples/fishing/game.json')), 'utf8')));
  const maximum = maximumPrize(definition);
  let initialStake;
  if (manifest) initialStake = uint(manifest.initialStake, 'Initial stake');
  else {
    const input = await ask(`Initial game stake in RF [${formatUnits(maximum, 18)}]: `);
    if (input && !/^[0-9]+(?:\.[0-9]{1,18})?$/.test(input)) throw new Error('Stake must be an RF amount with at most 18 decimal places.');
    initialStake = input ? parseUnits(input, 18) : maximum;
  }
  if (initialStake < maximum) throw new Error('Initial stake must cover the highest prize.');
  const { account, client, wallet } = await signingClients();
  let funding;
  if (!resume) funding = await preflight(client, account.address, initialStake);
  else if (!equal(account.address, manifest.deployer)) throw new Error('Resume with the original deployer account.');
  console.log(`Network: Robinhood mainnet (${MAINNET.chainId})\nSigner/team: ${account.address}\nGenerations: ${MAINNET.generations}\nRF: ${MAINNET.rf}\nDice: ${MAINNET.entropy}\nProvider: ${MAINNET.provider}`);
  console.log(`Game: ${definition.name}\nConsumable: ${definition.consumable}\nPrice: ${formatUnits(definition.price, 18)} RF\nInitial stake: ${formatUnits(initialStake, 18)} RF\nHighest prize: ${formatUnits(maximum, 18)} RF`);
  for (const outcome of definition.outcomes) console.log(`  ${outcome.name}: ${outcome.chanceBps}/10000; ${formatUnits(outcome.reward, 18)} RF`);
  if (funding) {
    console.log(`Deployer RF: ${formatUnits(funding.balance, 18)}\nDice fee now: ${formatEther(funding.fee)} ETH per batch`);
    const data = encodeDeployData({ abi: built.abi, bytecode: built.bytecode.object, args: constructorArgs(definition) });
    const [gas, gasPrice] = await Promise.all([client.estimateGas({ account, data }), client.getGasPrice()]);
    console.log(`Deployment estimate: ${gas} gas; ${formatEther(gas * gasPrice)} ETH at current gas price. RF approval and funding also cost gas.`);
    if (funding.eth < gas * gasPrice) throw new Error('ETH balance does not cover the deployment gas estimate.');
  } else console.log(`Resume existing deployment: ${manifest.game ?? manifest.transactions[0]?.hash}`);
  if (await ask('Type DEPLOY to send these mainnet transactions: ') !== 'DEPLOY') throw new Error('Cancelled before broadcasting.');
  let manifestPath = resume ? resolve(args[1]) : undefined;
  const save = async value => {
    const next = resolve(ROOT, 'contracts/deployments', `${MAINNET.chainId}-${value.game ?? value.transactions[0].hash}.json`);
    await saveManifest(next, value);
    if (manifestPath && manifestPath !== next) await rm(manifestPath, { force: true });
    manifestPath = next;
    console.log(`Manifest: ${manifestPath}`);
  };
  try {
    if (!manifest) manifest = await deployGame({ client, wallet, account, definition, built, initialStake, save });
    if (!manifest.game) {
      const confirmed = await receipt(client, manifest.transactions[0].hash);
      if (!confirmed.contractAddress) throw new Error('Deployment receipt has no contract address.');
      manifest.game = confirmed.contractAddress; manifest.status = 'deployed';
      manifest.transactions[0].status = 'confirmed'; await save(manifest);
    }
    await fundDeployment({ client, wallet, account, abi: built.abi, manifest, save });
    console.log(`Confirmed game: ${manifest.game}\nConfirmed consumable: ${manifest.consumable}\nManifest: ${manifestPath}`);
    console.log('Start the game with friendsdk dev <game-directory> --deployment <manifest>. The browser handles purchases, casts, and settlement through your wallet. resolve:contracts remains available for pending play recovery.');
  } catch (error) {
    if (manifestPath) console.error(`Inspect the recorded transactions before retrying. Resume: npm run deploy:contracts -- --resume ${manifestPath}`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(reportError);
