import { encodeFunctionData, isAddress, parseAbi, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem';
import { CHANCE_GAME_ABI } from './chance-game-abi.js';

export type ChanceDeployment = Readonly<{ chainId: number; game: Address; generations: Address; rf: Address }>;
export type ChancePublicClient = Pick<PublicClient, 'getChainId' | 'getBlockNumber' | 'getBlock' | 'readContract' | 'waitForTransactionReceipt'>;
export type ChanceWalletClient = Pick<WalletClient, 'chain' | 'getChainId' | 'getAddresses' | 'writeContract'>;
export type ChanceTransportOptions = Readonly<{
  deployment: ChanceDeployment; account: Address; publicClient: ChancePublicClient;
  walletClient?: ChanceWalletClient; confirmations?: number;
  selectedFriend?: Readonly<{ friendId: bigint; recipient: Address }>;
}>;
export type ChanceTransactionFailure = 'unconfirmed' | 'reverted' | 'replaced' | 'reorg' | 'unverified';

/** The transaction may already exist. Inspect its hash before attempting another action. */
export class ChanceTransactionError extends Error {
  constructor(public readonly code: ChanceTransactionFailure, public readonly transactionHash: Hex, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChanceTransactionError';
  }
}

const GENERATIONS_ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function generation(uint256) view returns (uint8)',
  'function tokenBoundAccount(uint256) view returns (address)',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const FRIEND_WALLET_ABI = parseAbi([
  'function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes result)',
  'function owner() view returns (address)',
  'function token() view returns (uint256 chainId, address tokenContract, uint256 tokenId)',
]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function address(value: Address): Address {
  if (!isAddress(value) || equal(value, zeroAddress)) throw new TypeError('Expected a nonzero deployment/account address.');
  return value;
}
function uint(value: bigint, name: string, positive = true): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value >= 1n << 256n) throw new RangeError(`Invalid ${name}.`);
  return value;
}

/** Trusted-host transport. Never give this object or its wallet to community frames.
 * Construction does no RPC/signing. Each mutation is an explicit host action; approval
 * and purchase are separate. Confirmations are host policy, not consensus finality.
 */
export function createChanceGameTransport(options: ChanceTransportOptions) {
  const deployment = Object.freeze({ ...options.deployment, game: address(options.deployment.game),
    generations: address(options.deployment.generations), rf: address(options.deployment.rf) });
  const { chainId, game, generations, rf } = deployment;
  const account = address(options.account), client = options.publicClient, wallet = options.walletClient;
  const confirmations = options.confirmations ?? 1;
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !Number.isSafeInteger(confirmations) || confirmations < 1) throw new RangeError('Invalid chain or confirmation count.');

  async function checkChain() {
    if (await client.getChainId() !== chainId) throw new Error(`Public client requires chain ${chainId}.`);
  }
  async function signer() {
    if (!wallet) throw new Error('A host wallet is required.');
    if (wallet.chain?.id !== chainId || await wallet.getChainId() !== chainId) throw new Error(`Wallet must be configured and connected to chain ${chainId}.`);
    const [selected] = await wallet.getAddresses();
    if (!selected || !equal(selected, account)) throw new Error('Selected wallet account changed.');
  }
  async function block() {
    await checkChain();
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const header = await client.getBlock({ blockNumber });
    if (!header.hash) throw new Error('No confirmed block is available.');
    return { blockNumber, blockHash: header.hash };
  }
  async function checkBlock(context: { blockNumber: bigint; blockHash: Hex }) {
    await checkChain();
    if (!equal((await client.getBlock({ blockNumber: context.blockNumber })).hash ?? '', context.blockHash)) {
      throw new Error('Observed block was reorganized; refresh before continuing.');
    }
  }
  let cachedTerms: { consumable: Address; price: bigint; maxPrize: bigint; outcomeCount: bigint } | undefined;
  const recipients = new Map<bigint, Address>(), rewards = new Map<bigint, bigint>();
  const committedPlays = new Map<bigint, { playId: bigint; friendId: bigint; batchId: bigint; outcomeId: bigint }>();
  if (options.selectedFriend) recipients.set(uint(options.selectedFriend.friendId, 'Friend ID'), address(options.selectedFriend.recipient));
  async function terms(blockNumber?: bigint) {
    const [boundRF, boundGenerations, consumable, price, maxPrize, outcomeCount] = await Promise.all([
      client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'rf', blockNumber }),
      client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'generations', blockNumber }),
      client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'consumable', blockNumber }),
      client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'price', blockNumber }),
      client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'maxPrize', blockNumber }),
      client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'outcomeCount', blockNumber }),
    ]);
    if (!equal(boundRF, rf) || !equal(boundGenerations, generations)) throw new Error('Game does not match the pinned RF/Generations deployment.');
    address(consumable); uint(price, 'game price'); uint(maxPrize, 'maximum prize');
    if (outcomeCount < 1n || outcomeCount > 10_000n) throw new Error('Invalid deployed outcome table.');
    return cachedTerms = { consumable, price, maxPrize, outcomeCount };
  }
  async function friend(friendId: bigint, blockNumber: bigint) {
    uint(friendId, 'Friend ID');
    const [owner, generation, recipient] = await Promise.all([
      client.readContract({ address: generations, abi: GENERATIONS_ABI, functionName: 'ownerOf', args: [friendId], blockNumber }),
      client.readContract({ address: generations, abi: GENERATIONS_ABI, functionName: 'generation', args: [friendId], blockNumber }),
      client.readContract({ address: generations, abi: GENERATIONS_ABI, functionName: 'tokenBoundAccount', args: [friendId], blockNumber }),
    ]);
    address(owner); address(recipient);
    const [walletOwner, [walletChain, collection, tokenId]] = await Promise.all([
      client.readContract({ address: recipient, abi: FRIEND_WALLET_ABI, functionName: 'owner', blockNumber }),
      client.readContract({ address: recipient, abi: FRIEND_WALLET_ABI, functionName: 'token', blockNumber }),
    ]);
    if (!equal(owner, walletOwner) || walletChain !== BigInt(chainId) || !equal(collection, generations) || tokenId !== friendId) {
      throw new Error('Canonical Friend wallet does not match its Generations token.');
    }
    return { friendId, owner, generation, recipient,
      canControl: generation > 0 && equal(account, owner) };
  }
  async function context(friendId?: bigint) {
    const head = await block(), gameTerms = await terms(head.blockNumber);
    const selected = friendId === undefined ? undefined : await friend(friendId, head.blockNumber);
    await checkBlock(head);
    return { ...head, ...gameTerms, selected };
  }
  // Deployment terms and the canonical address are stable session metadata. Contracts
  // enforce ownership, inventory and balances when executing the fixed action.
  async function writeContext(friendId: bigint) {
    uint(friendId, 'Friend ID');
    if (!cachedTerms) { await checkChain(); await terms(); }
    let recipient = recipients.get(friendId);
    if (!recipient) {
      recipient = address(await client.readContract({ address: generations, abi: GENERATIONS_ABI,
        functionName: 'tokenBoundAccount', args: [friendId] }));
      recipients.set(friendId, recipient);
    }
    return { ...cachedTerms!, selected: { friendId, recipient } };
  }
  async function send(selected: { friendId: bigint; recipient: Address }, functionName: 'approve' | 'buy' | 'play' | 'settle' | 'redeem', args: readonly bigint[] | readonly [Address, bigint]) {
    await signer();
    const target = functionName === 'approve' ? rf : game;
    const abi = functionName === 'approve' ? ERC20_ABI : CHANCE_GAME_ABI;
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const execution = { address: selected.recipient, abi: FRIEND_WALLET_ABI, functionName: 'execute' as const,
      args: [target, 0n, data, 0] as const, account, value: 0n };
    const transactionHash = await wallet!.writeContract({ ...execution, chain: wallet!.chain });
    let receipt: TransactionReceipt;
    try { receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations }); }
    catch (cause) { throw new ChanceTransactionError('unconfirmed', transactionHash, 'Transaction confirmation is unknown; inspect the hash before retrying.', { cause }); }
    if (!equal(receipt.transactionHash, transactionHash)) throw new ChanceTransactionError('replaced', transactionHash, `Transaction was replaced by ${receipt.transactionHash}; inspect that receipt.`);
    if (receipt.status !== 'success') throw new ChanceTransactionError('reverted', transactionHash, 'Transaction reverted.');
    return { transactionHash, receipt };
  }
  async function verified<T>(result: Awaited<ReturnType<typeof send>>, check: (receipt: TransactionReceipt) => Promise<T>) {
    let details: T;
    try { details = await check(result.receipt); }
    catch (cause) {
      throw new ChanceTransactionError('unverified', result.transactionHash, 'Receipt succeeded but its game result could not be verified; inspect before retrying.', { cause });
    }
    try { await checkBlock({ blockNumber: result.receipt.blockNumber, blockHash: result.receipt.blockHash }); }
    catch (cause) { throw new ChanceTransactionError('reorg', result.transactionHash, 'Receipt is no longer confirmed on the expected chain.', { cause }); }
    return { mode: 'chain' as const, transactionHash: result.transactionHash,
      blockNumber: result.receipt.blockNumber, blockHash: result.receipt.blockHash, ...details };
  }
  const gameLogs = (receipt: TransactionReceipt) => receipt.logs.filter(log => equal(log.address, game));
  function transfer(receipt: TransactionReceipt, token: Address, from: Address, to: Address, amount: bigint) {
    const events = parseEventLogs({ abi: ERC20_ABI, eventName: 'Transfer', strict: true,
      logs: receipt.logs.filter(log => equal(log.address, token)) });
    if (!events.some(event => equal(event.args.from, from) && equal(event.args.to, to) && event.args.value === amount)) throw new Error('Expected RF/consumable transfer is missing.');
  }
  function itemTransfer(receipt: TransactionReceipt, from: Address, to: Address, id: bigint, amount: bigint) {
    const events = parseEventLogs({ abi: CHANCE_GAME_ABI, eventName: 'TransferSingle', logs: gameLogs(receipt), strict: true });
    if (!events.some(event => equal(event.args.from, from) && equal(event.args.to, to) && event.args.id === id && event.args.value === amount)) throw new Error('Expected Friend inventory transfer is missing.');
  }
  async function playAt(playId: bigint, blockNumber: bigint) {
    uint(playId, 'play ID');
    const [friendId, batchId, outcomeId] = await client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'plays', args: [playId], blockNumber });
    if (batchId === 0n) throw new Error('Unknown play.');
    const play = { playId, friendId, batchId, outcomeId };
    committedPlays.set(playId, play); return play;
  }

  return Object.freeze({ mode: 'chain' as const, deployment, account,
    async read(friendId: bigint) {
      const ctx = await context(friendId), selected = ctx.selected!;
      const ids = Array.from({ length: Number(ctx.outcomeCount) }, (_, index) => BigInt(index + 1));
      const [stake, reservedPlays, rewardLiability, recipientRF, consumables, inventory, outcomes] = await Promise.all([
        client.readContract({ address: rf, abi: ERC20_ABI, functionName: 'balanceOf', args: [game], blockNumber: ctx.blockNumber }),
        client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'reservedPlays', blockNumber: ctx.blockNumber }),
        client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'rewardLiability', blockNumber: ctx.blockNumber }),
        client.readContract({ address: rf, abi: ERC20_ABI, functionName: 'balanceOf', args: [selected.recipient], blockNumber: ctx.blockNumber }),
        client.readContract({ address: ctx.consumable, abi: ERC20_ABI, functionName: 'balanceOf', args: [selected.recipient], blockNumber: ctx.blockNumber }),
        client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'balanceOfBatch', args: [ids.map(() => selected.recipient), ids], blockNumber: ctx.blockNumber }),
        Promise.all(ids.map(id => client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'outcomes', args: [id], blockNumber: ctx.blockNumber }))),
      ]);
      await checkBlock(ctx);
      if (stake < reservedPlays + rewardLiability) throw new Error('Game stake is below recorded liabilities.');
      recipients.set(friendId, selected.recipient);
      outcomes.forEach(([, reward], index) => rewards.set(ids[index], reward));
      return { mode: 'chain' as const, deployment, blockNumber: ctx.blockNumber, blockHash: ctx.blockHash, ...selected,
        payer: selected.recipient, payerRF: recipientRF, recipientRF, consumables, stake, reservedPlays, rewardLiability,
        freeStake: stake - reservedPlays - rewardLiability, price: ctx.price, maxPrize: ctx.maxPrize,
        outcomes: outcomes.map(([chanceBps, reward, metadataURI], index) => ({ id: ids[index], chanceBps, reward, metadataURI, quantity: inventory[index] })) };
    },
    async approvePurchase(friendId: bigint, quantity: bigint) {
      uint(quantity, 'quantity');
      const ctx = await writeContext(friendId);
      const amount = uint(ctx.price * quantity, 'purchase cost');
      return verified(await send(ctx.selected!, 'approve', [game, amount]), async receipt => {
        const events = parseEventLogs({ abi: ERC20_ABI, eventName: 'Approval', strict: true, logs: receipt.logs.filter(log => equal(log.address, rf)) });
        if (!events.some(event => equal(event.args.owner, ctx.selected!.recipient) && equal(event.args.spender, game) && event.args.value === amount)) throw new Error('Exact Friend wallet RF approval event is missing.');
        return { payer: ctx.selected!.recipient, spender: game, amount };
      });
    },
    async buy(friendId: bigint, quantity: bigint) {
      uint(quantity, 'quantity');
      const ctx = await writeContext(friendId);
      const payment = uint(ctx.price * quantity, 'purchase cost');
      return verified(await send(ctx.selected!, 'buy', [friendId, quantity]), async receipt => {
        const events = parseEventLogs({ abi: CHANCE_GAME_ABI, eventName: 'Purchased', logs: gameLogs(receipt), strict: true });
        if (!events.some(event => event.args.friendId === friendId && event.args.quantity === quantity && event.args.payment === payment)) throw new Error('Purchase event does not match.');
        transfer(receipt, rf, ctx.selected!.recipient, game, payment);
        transfer(receipt, ctx.consumable, zeroAddress, ctx.selected!.recipient, quantity);
        return { friendId, quantity, payment, payer: ctx.selected!.recipient, recipient: ctx.selected!.recipient };
      });
    },
    async play(friendId: bigint, quantity = 1n) {
      uint(quantity, 'quantity');
      const ctx = await writeContext(friendId);
      return verified(await send(ctx.selected!, 'play', [friendId, quantity]), async receipt => {
        const events = parseEventLogs({ abi: CHANCE_GAME_ABI, eventName: 'Played', logs: gameLogs(receipt), strict: true });
        if (BigInt(events.length) !== quantity || events.some(event => event.args.friendId !== friendId)) throw new Error('Committed plays do not match.');
        transfer(receipt, ctx.consumable, ctx.selected!.recipient, zeroAddress, quantity);
        const plays = await Promise.all(events.map(event => playAt(event.args.playId, receipt.blockNumber)));
        for (const [index, committed] of plays.entries()) {
          if (committed.friendId !== friendId || committed.batchId !== events[index].args.batchId ||
              committed.playId !== plays[0].playId + BigInt(index) || committed.batchId !== plays[0].batchId) throw new Error('Stored play does not match its receipt.');
        }
        return { friendId, plays };
      });
    },
    async readPlay(playId: bigint) {
      const ctx = await block(), play = await playAt(playId, ctx.blockNumber);
      await checkBlock(ctx);
      return { mode: 'chain' as const, blockNumber: ctx.blockNumber, blockHash: ctx.blockHash, ...play };
    },
    async settle(playId: bigint, committed?: Awaited<ReturnType<typeof playAt>>) {
      uint(playId, 'play ID');
      if (committed && committed.playId !== playId) throw new Error('Committed play ID does not match.');
      const before = committed ?? committedPlays.get(playId) ?? await playAt(playId, await client.getBlockNumber({ cacheTime: 0 }));
      const ctx = await writeContext(before.friendId), selected = ctx.selected;
      if (before.outcomeId !== 0n) throw new Error('Play is already settled.');
      return verified(await send(selected, 'settle', [playId]), async receipt => {
        const events = parseEventLogs({ abi: CHANCE_GAME_ABI, eventName: 'Settled', logs: gameLogs(receipt), strict: true });
        const event = events.find(event => event.args.playId === playId && event.args.friendId === before.friendId);
        if (!event || event.args.outcomeId < 1n || event.args.outcomeId > ctx.outcomeCount) throw new Error('Settlement event does not match.');
        const after = await playAt(playId, receipt.blockNumber);
        if (after.friendId !== before.friendId || after.batchId !== before.batchId || after.outcomeId !== event.args.outcomeId) throw new Error('Stored result does not match its receipt.');
        itemTransfer(receipt, zeroAddress, selected.recipient, after.outcomeId, 1n);
        return { ...after, recipient: selected.recipient };
      });
    },
    async redeem(friendId: bigint, outcomeId: bigint, quantity: bigint) {
      uint(quantity, 'quantity'); uint(outcomeId, 'outcome ID');
      const ctx = await writeContext(friendId);
      if (outcomeId > ctx.outcomeCount) throw new RangeError('Unknown outcome.');
      let reward = rewards.get(outcomeId);
      if (reward === undefined) {
        [, reward] = await client.readContract({ address: game, abi: CHANCE_GAME_ABI, functionName: 'outcomes', args: [outcomeId] });
        rewards.set(outcomeId, reward);
      }
      const payment = uint(reward * quantity, 'redemption value');
      return verified(await send(ctx.selected!, 'redeem', [friendId, outcomeId, quantity]), async receipt => {
        const events = parseEventLogs({ abi: CHANCE_GAME_ABI, eventName: 'Redeemed', logs: gameLogs(receipt), strict: true });
        if (!events.some(event => event.args.friendId === friendId && event.args.outcomeId === outcomeId && event.args.quantity === quantity && event.args.payment === payment)) throw new Error('Redemption event does not match.');
        itemTransfer(receipt, ctx.selected!.recipient, zeroAddress, outcomeId, quantity);
        transfer(receipt, rf, game, ctx.selected!.recipient, payment);
        return { friendId, outcomeId, quantity, payment, recipient: ctx.selected!.recipient };
      });
    },
  });
}
