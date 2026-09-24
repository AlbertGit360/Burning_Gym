import { isAddress, parseAbi, parseAbiItem, parseEventLogs, zeroAddress, type Address, type PublicClient } from "viem";
import { CHANCE_GAME_ABI } from "./chance-game-abi.js";
import { ChanceTransactionError, createChanceGameTransport, type ChanceDeployment, type ChancePublicClient, type ChanceWalletClient } from "./chain.js";
import { defineChanceGame, maximumPrize, type ChanceGameDefinition, type GameClient, type GamePlay, type GameSnapshot } from "./game.js";

export type LiveGameDeployment = ChanceDeployment & Readonly<{ entropy: Address; provider: Address; deploymentBlock?: bigint }>;
export type LiveGamePublicClient = ChancePublicClient & Pick<PublicClient, "getLogs">;
/** The host must disclose this maximum plus gas before authorizing settlement. */
export const LIVE_GAME_MAX_ORACLE_FEE = 25_000_000_000_000n;
export type LiveGameOptions = Readonly<{
  definition: ChanceGameDefinition; deployment: LiveGameDeployment; friendId: bigint; account: Address;
  publicClient: LiveGamePublicClient; walletClient: ChanceWalletClient;
  assertActive?: () => void | Promise<void>;
  maxOracleFee?: bigint; waitMs?: number;
  /** Canonical wallet resolved by the trusted runtime during initial eligibility. */
  friendWallet?: Address;
}>;
const TOKEN_ABI = parseAbi(["function allowance(address owner,address spender) view returns(uint256)"]);
const DICE_ABI = parseAbi(["function getFeeV2(address provider,uint32 gasLimit) view returns(uint128)"]);
const PLAYED_EVENT = parseAbiItem("event Played(uint256 indexed playId,uint256 indexed friendId,uint256 indexed batchId)");
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const positive = (value: bigint) => typeof value === "bigint" && value > 0n && value < 1n << 256n;
const quantity = (value: bigint) => { if (!positive(value) || value > 99n) throw new RangeError("Choose a quantity from 1 through 99."); };

/** Trusted runtime adapter only. Never pass its wallet or public client into a game frame. */
export function createLiveGameClient(options: LiveGameOptions): GameClient {
  const definition = defineChanceGame(options.definition), deployment = Object.freeze({ ...options.deployment });
  const { friendId, account, publicClient: client, walletClient: wallet } = options;
  const maximum = maximumPrize(definition), maxFee = options.maxOracleFee ?? LIVE_GAME_MAX_ORACLE_FEE;
  const waitMs = options.waitMs ?? 30_000, fromBlock = deployment.deploymentBlock ?? 0n;
  if (!positive(friendId) || typeof fromBlock !== "bigint" || fromBlock < 0n) throw new RangeError("Invalid Friend ID or deployment block.");
  if (typeof maxFee !== "bigint" || maxFee < 0n || maxFee > LIVE_GAME_MAX_ORACLE_FEE) throw new RangeError("Invalid maximum Dice fee.");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new RangeError("Wait time must be from 0 through 30000 ms.");
  for (const address of [deployment.entropy, deployment.provider]) if (!isAddress(address) || equal(address, zeroAddress)) throw new TypeError("Invalid Dice deployment.");
  const active = async () => { await options.assertActive?.(); };
  // Local session invalidation runs immediately before every wallet prompt.
  const guardedWallet: ChanceWalletClient = { ...wallet, writeContract: (async request => {
    await active(); return wallet.writeContract(request);
  }) as ChanceWalletClient["writeContract"] };
  const transport = createChanceGameTransport({ deployment, account, publicClient: client, walletClient: guardedWallet,
    selectedFriend: options.friendWallet ? { friendId, recipient: options.friendWallet } : undefined });
  let busy = false, uncertain: ChanceTransactionError | null = null;
  type CommittedPlay = { playId: bigint; friendId: bigint; batchId: bigint; outcomeId: bigint };
  const knownPlays = new Map<bigint, CommittedPlay>();
  let latestState: Awaited<ReturnType<typeof transport.read>> | undefined;
  let historyLoaded = false, cachedAllowance: bigint | undefined;
  const initializedState = () => latestState ? Promise.resolve(latestState) : verifiedState();

  async function verifiedState() {
    await active();
    const state = await transport.read(friendId);
    const [entropy, provider] = await Promise.all([
      client.readContract({ address: deployment.game, abi: CHANCE_GAME_ABI, functionName: "entropy", blockNumber: state.blockNumber }),
      client.readContract({ address: deployment.game, abi: CHANCE_GAME_ABI, functionName: "provider", blockNumber: state.blockNumber }),
    ]);
    if (!state.canControl) throw new Error("The connected account must own the selected hardwired Friend.");
    if (!equal(entropy, deployment.entropy) || !equal(provider, deployment.provider)) throw new Error("Deployed Dice dependencies do not match this game.");
    if (state.price !== definition.price || state.maxPrize !== maximum || state.outcomes.length !== definition.outcomes.length ||
        state.outcomes.some((outcome, index) => outcome.chanceBps !== definition.outcomes[index].chanceBps || outcome.reward !== definition.outcomes[index].reward)) {
      throw new Error("Deployed game prices, outcome weights or rewards do not match the displayed definition.");
    }
    await active(); latestState = state; return state;
  }
  async function read(): Promise<GameSnapshot> {
    const state = await verifiedState();
    const logs = await client.getLogs({ address: deployment.game, event: PLAYED_EVENT, args: { friendId },
      fromBlock, toBlock: state.blockNumber, strict: true });
    if (logs.length > 10_000) throw new Error("This Friend's play history exceeds the supported read size.");
    for (const log of logs) {
      if (log.removed || !equal(log.address, deployment.game) || log.args.friendId !== friendId || !positive(log.args.playId)) throw new Error("Invalid Friend play history.");
      if (!knownPlays.has(log.args.playId)) knownPlays.set(log.args.playId, { playId: log.args.playId, friendId, batchId: log.args.batchId, outcomeId: 0n });
    }
    const plays: GamePlay[] = [];
    const ids = [...knownPlays.keys()].sort((a, b) => a < b ? -1 : 1);
    for (let offset = 0; offset < ids.length; offset += 12) {
      const group = await Promise.all(ids.slice(offset, offset + 12).map(async id => {
        const [ownerFriend, batchId, outcomeId] = await client.readContract({ address: deployment.game, abi: CHANCE_GAME_ABI,
          functionName: "plays", args: [id], blockNumber: state.blockNumber });
        if (ownerFriend !== friendId || !positive(batchId) || outcomeId < 0n || outcomeId > BigInt(definition.outcomes.length)) throw new Error("Stored play does not match this Friend.");
        knownPlays.set(id, { playId: id, friendId, batchId, outcomeId });
        return Object.freeze({ id, outcomeId: outcomeId === 0n ? null : Number(outcomeId) });
      }));
      plays.push(...group);
    }
    if (!equal((await client.getBlock({ blockNumber: state.blockNumber })).hash ?? "", state.blockHash)) throw new Error("Game state changed during a chain reorganization. Refresh before continuing.");
    await active();
    historyLoaded = true;
    return Object.freeze({ mode: "chain", friendId, rfBalance: state.recipientRF, consumables: state.consumables, stake: state.stake,
      freeStake: state.freeStake, reservedPlays: state.reservedPlays, rewardLiability: state.rewardLiability,
      inventory: Object.freeze(state.outcomes.map(outcome => outcome.quantity)), plays: Object.freeze(plays) });
  }
  async function mutate<T>(work: () => Promise<T>): Promise<T> {
    await active();
    if (uncertain) throw uncertain;
    if (busy) throw new Error("Another game transaction is pending.");
    busy = true;
    try { return await work(); }
    catch (error) {
      if (error instanceof ChanceTransactionError && error.code !== "reverted") uncertain = error;
      throw error;
    } finally { busy = false; }
  }
  async function ownPlay(id: bigint) {
    if (!positive(id)) throw new RangeError("Invalid play ID.");
    const play = knownPlays.get(id) ?? await transport.readPlay(id);
    if (play.friendId !== friendId) throw new Error("This play belongs to a different Friend.");
    knownPlays.set(id, play); return play;
  }
  async function requestDice(batchId: bigint) {
    const fee = await client.readContract({ address: deployment.entropy, abi: DICE_ABI,
      functionName: "getFeeV2", args: [deployment.provider, 200_000] });
    if (fee > maxFee) throw new Error("Dice fee exceeds the approved maximum. Keep this pending cast and review the fee before retrying.");
    const request = { address: deployment.game, abi: CHANCE_GAME_ABI, functionName: "requestRandomness" as const,
      args: [batchId] as const, account, value: fee };

    if (wallet.chain?.id !== deployment.chainId || await wallet.getChainId() !== deployment.chainId ||
        !equal((await wallet.getAddresses())[0] ?? "", account)) throw new Error("Selected wallet account or network changed.");
    const hash = await guardedWallet.writeContract({ ...request, chain: wallet.chain });
    let receipt;
    try { receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 }); }
    catch (cause) { throw new ChanceTransactionError("unconfirmed", hash, `Dice transaction ${hash} is unconfirmed. Inspect it before retrying this same cast.`, { cause }); }
    if (!equal(receipt.transactionHash, hash)) throw new ChanceTransactionError("replaced", hash, "Dice transaction was replaced. Inspect its receipt before retrying this cast.");
    if (receipt.status !== "success") throw new ChanceTransactionError("reverted", hash, "Dice request reverted. Retry the same pending cast after checking the fee.");
    if (!equal(receipt.from, account) || !equal(receipt.to ?? "", deployment.game)) throw new ChanceTransactionError("unverified", hash, "Dice receipt does not match the expected account and game. Inspect it before retrying.");
    if (await client.getChainId() !== deployment.chainId || !equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash ?? "", receipt.blockHash)) throw new ChanceTransactionError("reorg", hash, "Dice receipt was reorganized. Inspect it before retrying this cast.");
    const [sequence, recorded] = await client.readContract({ address: deployment.game, abi: CHANCE_GAME_ABI,
      functionName: "randomness", args: [batchId], blockNumber: receipt.blockNumber });
    const events = parseEventLogs({ abi: CHANCE_GAME_ABI, eventName: "RandomnessRequested", strict: true,
      logs: receipt.logs.filter(log => equal(log.address, deployment.game)) });
    if (!recorded || sequence === 0n || !events.some(event => event.args.batchId === batchId && event.args.sequenceNumber === sequence)) {
      throw new ChanceTransactionError("unverified", hash, "Dice receipt could not be verified. Inspect it before retrying this cast.");
    }
  }
  return Object.freeze({ mode: "chain" as const, definition, read,
    async canBuy(count: bigint) {
      if (!positive(count) || count > 99n) return false;
      const state = await initializedState(), cost = count * definition.price;
      return state.recipientRF >= cost && state.freeStake >= maximum && state.freeStake + cost >= count * maximum;
    },
    buy: (count: bigint) => mutate(async () => {
      quantity(count); const state = await initializedState(), cost = count * definition.price;
      const allowance = cachedAllowance ?? await client.readContract({ address: deployment.rf, abi: TOKEN_ABI, functionName: "allowance",
        args: [state.recipient, deployment.game] });
      if (allowance !== cost) { await active(); await transport.approvePurchase(friendId, count); }
      cachedAllowance = cost;
      await active(); await transport.buy(friendId, count); cachedAllowance = 0n;
    }),
    play: (count = 1n) => mutate(async () => {
      quantity(count); if (!historyLoaded) await read();
      const pending = [...knownPlays.values()].find(play => play.outcomeId === 0n);
      if (pending) throw new Error(`Cast #${pending.playId} is pending. Finish that same cast before starting another.`);
      await active(); const result = await transport.play(friendId, count);
      return Object.freeze(result.plays.map(play => { knownPlays.set(play.playId, play); return Object.freeze({ id: play.playId, outcomeId: null }); }));
    }),
    settle: (id: bigint) => mutate(async () => {
      await initializedState(); const play = await ownPlay(id);
      if (play.outcomeId !== 0n) return Object.freeze({ id, outcomeId: Number(play.outcomeId) });
      const randomness = () => client.readContract({ address: deployment.game, abi: CHANCE_GAME_ABI, functionName: "randomness", args: [play.batchId] });
      let status = await randomness();
      if (!status[1]) { await active(); await requestDice(play.batchId); status = await randomness(); }
      const deadline = Date.now() + waitMs;
      while (!status[2] && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        await active(); status = await randomness();
      }
      if (!status[2]) return Object.freeze({ id, outcomeId: null });
      await active(); const result = await transport.settle(id, play);
      knownPlays.set(id, result);
      return Object.freeze({ id, outcomeId: Number(result.outcomeId) });
    }),
    redeem: (outcomeId: number, count: bigint) => mutate(async () => {
      quantity(count); if (!Number.isInteger(outcomeId) || outcomeId < 1 || outcomeId > definition.outcomes.length) throw new RangeError("Invalid outcome.");
      await initializedState(); await active(); await transport.redeem(friendId, BigInt(outcomeId), count);
    }),
  });
}
