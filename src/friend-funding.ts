import { isAddress, parseAbi, parseEventLogs, zeroAddress, type Hex } from "viem";
import { ChanceTransactionError } from "./chain.js";
import type { LiveGameOptions } from "./live-game.js";

const RF_ABI = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Trusted wallet menu only. Transfers the explicitly entered RF amount to the verified Friend wallet. */
export async function fundFriendWallet(options: LiveGameOptions & { amount: bigint }): Promise<Hex> {
  const { deployment, account, publicClient, walletClient, friendId, amount, assertActive } = options;
  if (typeof amount !== "bigint" || amount <= 0n || amount >= 1n << 256n) throw new Error("Invalid RF amount.");
  await assertActive?.();
  const recipient = options.friendWallet ?? await publicClient.readContract({ address: deployment.generations,
    abi: parseAbi(["function tokenBoundAccount(uint256) view returns (address)"]), functionName: "tokenBoundAccount", args: [friendId] });
  if (!isAddress(recipient) || equal(recipient, zeroAddress)) throw new Error("Invalid canonical Friend wallet.");
  if (await walletClient.getChainId() !== deployment.chainId || walletClient.chain?.id !== deployment.chainId) throw new Error("Wallet network changed.");
  const [current] = await walletClient.getAddresses();
  if (!current || !equal(current, account)) throw new Error("Wallet account changed.");
  await assertActive?.();
  const hash = await walletClient.writeContract({ account, chain: walletClient.chain, address: deployment.rf, abi: RF_ABI,
    functionName: "transfer", args: [recipient, amount] });
  let receipt;
  try { receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }); }
  catch (cause) { throw new ChanceTransactionError("unconfirmed", hash, `RF transfer confirmation is unknown. Inspect ${hash} before retrying.`, { cause }); }
  if (!equal(receipt.transactionHash, hash)) throw new ChanceTransactionError("replaced", hash, `RF transfer replaced. Inspect ${receipt.transactionHash} before retrying.`);
  if (receipt.status !== "success") throw new ChanceTransactionError("reverted", hash, `RF transfer reverted: ${hash}`);
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  if (await publicClient.getChainId() !== deployment.chainId || !equal(block.hash ?? "", receipt.blockHash)) {
    throw new ChanceTransactionError("reorg", hash, `RF transfer receipt changed. Inspect ${hash} before retrying.`);
  }
  const transfers = parseEventLogs({ abi: RF_ABI, eventName: "Transfer", strict: true,
    logs: receipt.logs.filter(log => equal(log.address, deployment.rf)) });
  if (!transfers.some(event => equal(event.args.from, account) && equal(event.args.to, recipient) && event.args.value === amount)) {
    throw new ChanceTransactionError("unverified", hash, `RF transfer receipt could not be verified. Inspect ${hash} before retrying.`);
  }
  return hash;
}
