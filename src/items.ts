/** Display data only. Inventories and rewards come from the game service. */
export type GameItem = Readonly<{
  id: string;
  name: string;
  description?: string;
  rarity?: string;
  art?: Readonly<{ rows: readonly string[] }>;
  /** Optional display precision; this does not configure a token or launch an economy. */
  token?: Readonly<{ decimals: number }>;
}>;
export type GameItemQuantities = Readonly<Record<string, bigint>>;
export type GameShopOffer = Readonly<{ id: string; itemId: string; quantity: bigint; price: bigint }>;
export type GameReward = Readonly<{ id: string; itemId: string; quantity: bigint }>;

/** Base units stay exact; no balance passes through Number. */
export function formatGameItemQuantity(item: GameItem, quantity: bigint): string {
  const places = item.token?.decimals ?? 0;
  if (typeof quantity !== "bigint" || quantity < 0n || quantity >= 1n << 256n) throw new RangeError("Quantity must fit uint256.");
  if (!Number.isInteger(places) || places < 0 || places > 255) throw new RangeError("Decimals must be from 0 through 255.");
  if (places === 0) return quantity.toString();
  const digits = quantity.toString().padStart(places + 1, "0");
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return `${digits.slice(0, -places)}${fraction ? `.${fraction}` : ""}`;
}
