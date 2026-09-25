/* ------------------------------------------------------------------------ *
 * Proof of Burn — a shared, verifiable character sheet for Rare Friends.
 *
 * A Friend's stats are not stored anywhere: they are DERIVED from its burn
 * receipts (one receipt per Friend sacrificed to train it) since its last
 * transfer. Any game can take the same receipts, run the same pure
 * functions below and get the same HP / Strength / Agility / Defence,
 * levels, Tier caps and combat numbers.
 *
 * This file has no React, no DOM and no SDK runtime dependency, so other
 * builders can copy or import it as-is. Burning Gym uses it for all of its
 * own balance math. See PROOF_OF_BURN.md for the written spec.
 *
 * Rules (matching the Rare Friends protocol docs, rarefriends.com/docs/generations):
 *   - Food chain: a Friend may only burn its own generation or weaker
 *     (a higher generation number is weaker / more common).
 *   - A burned Friend gives XP equal to its generation's hardwire value
 *     (Gen 1 = 100,000 ... Gen 6 = 1; 10x per generation).
 *   - One Friend of your OWN generation takes a stat from level 0 to 100;
 *     the curve is quadratic, so weaker fuel still buys early levels.
 *   - Tier 0-4 caps every stat at 20 / 40 / 60 / 80 / 100. XP above the cap
 *     is kept and counts once the next Tier is bought.
 *   - A transfer resets the sheet, exactly like the protocol resets Tier:
 *     only receipts after the last transfer count (see receiptsSince).
 * ------------------------------------------------------------------------ */

export const PROOF_OF_BURN_VERSION = 1;

export const STAT_KEYS = ["hp", "str", "agi", "def"] as const;
export type StatKey = typeof STAT_KEYS[number];
export type Stats = Record<StatKey, number>;
export type Generation = 1 | 2 | 3 | 4 | 5 | 6;
export type Tier = 0 | 1 | 2 | 3 | 4;

/** Stat cap for each Tier: every Tier unlocks the next 20 levels. */
export const TIER_MAX_LEVEL = [20, 40, 60, 80, 100] as const;

/** The protocol's hardwire value in RF for a generation: Gen 1 = 100,000 ... Gen 6 = 1. */
export function generationMultiplier(generation: number): number {
  return 10 ** Math.max(0, 6 - generation);
}
/** XP a burned Friend of this generation gives: its hardwire value. */
export function burnXp(generation: Generation): number {
  return generationMultiplier(generation);
}
/** Training time a burned Friend of this generation adds: 5 s (Gen 6) up to 10 h 48 m (Gen 1), ×6 per generation. */
export function trainingSecondsFor(generation: Generation): number {
  return 5 * 6 ** (6 - generation);
}
/** Food chain: a Friend may burn its own generation or weaker (higher number). */
export function canBurn(ownGeneration: number, burnedGeneration: number): boolean {
  return burnedGeneration >= ownGeneration;
}

/** Total XP needed to reach `level` when a same-generation burn is worth `scale` XP. */
export function cumulativeXpForLevel(level: number, scale: number): number {
  return Math.round(scale * (level / 100) ** 2);
}
/** Raw level (0-100, ignoring Tier caps) for `xp` when a same-generation burn is worth `scale` XP. */
export function levelForXp(xp: number, scale: number): number {
  if (scale <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor(100 * Math.sqrt(Math.min(1, xp / scale)))));
}
/** Displayed level: floored at 1 and clamped to the Tier cap (banked XP above the cap is kept, not lost). */
export function cappedLevel(xp: number, ownGeneration: number, tier: Tier): number {
  return Math.max(1, Math.min(TIER_MAX_LEVEL[tier], levelForXp(xp, generationMultiplier(ownGeneration))));
}

/* ---------------- Combat numbers (shared by every game that reads the sheet) ---------------- */
export const BASE_ATTACK_COOLDOWN_MS = 1500;
export function maxHpFor(hpLevel: number): number { return 9 + hpLevel; }
export function maxHitFor(strengthLevel: number): number { return Math.floor(1 + strengthLevel * 0.5); }
/** Damage subtracted from every hit taken (a landed hit always deals at least 1). */
export function defenceValueFor(defenceLevel: number): number { return Math.max(0, defenceLevel - 1); }
export function attackCooldownMs(agilityLevel: number): number { return BASE_ATTACK_COOLDOWN_MS / (1 + agilityLevel * 0.01); }
/** Combat Level: the average of the four stat levels. */
export function combatLevel(levels: Stats): number {
  return Math.round((levels.hp + levels.str + levels.agi + levels.def) / 4);
}

/* ---------------- Burn receipts ---------------- */
/**
 * One sacrificed Friend. Token ids are decimal strings (no bigint), so a
 * receipt is plain JSON. In an on-chain version this is exactly the data a
 * burn event would carry; in this preview the burns are simulated.
 */
export type BurnReceipt = Readonly<{
  v: typeof PROOF_OF_BURN_VERSION;
  /** Token id of the Friend being trained. */
  friend: string;
  /** Token id of the Friend that was burned. */
  burned: string;
  burnedGeneration: Generation;
  stat: StatKey;
  xp: number;
  trainingSeconds: number;
  /** Unix ms when the Friend was burned. */
  burnedAt: number;
  /** Unix ms when the training finished and the XP started to count. */
  trainedAt?: number;
}>;

export function makeReceipt(friend: string, burned: string, burnedGeneration: Generation, stat: StatKey, burnedAt: number): BurnReceipt {
  return { v: PROOF_OF_BURN_VERSION, friend, burned, burnedGeneration, stat, xp: burnXp(burnedGeneration), trainingSeconds: trainingSecondsFor(burnedGeneration), burnedAt };
}
/** Reset on transfer: only receipts after the Friend's last transfer count. */
export function receiptsSince(receipts: readonly BurnReceipt[], lastTransferAt: number): BurnReceipt[] {
  return receipts.filter(receipt => receipt.burnedAt >= lastTransferAt);
}
/** Only finished trainings count toward stats. */
export function statXpFromReceipts(receipts: readonly BurnReceipt[]): Stats {
  const xp: Stats = { hp: 0, str: 0, agi: 0, def: 0 };
  for (const receipt of receipts) if (receipt.trainedAt !== undefined) xp[receipt.stat] += receipt.xp;
  return xp;
}

/* ---------------- The character sheet ---------------- */
export type CharacterSheet = Readonly<{
  standard: "proof-of-burn";
  version: typeof PROOF_OF_BURN_VERSION;
  friend: Readonly<{ id: string; generation: number; family?: string }>;
  tier: Tier;
  cap: number;
  stats: Record<StatKey, Readonly<{ xp: number; level: number; levelIfUncapped: number }>>;
  combat: Readonly<{ maxHp: number; maxHit: number; attackSeconds: number; damageBlocked: number; combatLevel: number }>;
  burns: Readonly<{ count: number; totalXp: number; byGeneration: Record<string, number> }>;
  receipts: readonly BurnReceipt[];
}>;

export function buildCharacterSheet(input: Readonly<{
  friendId: string; generation: number; family?: string; tier: Tier;
  receipts: readonly BurnReceipt[]; lastTransferAt?: number;
}>): CharacterSheet {
  const receipts = receiptsSince(input.receipts, input.lastTransferAt ?? 0).filter(receipt => receipt.friend === input.friendId);
  const xp = statXpFromReceipts(receipts), scale = generationMultiplier(input.generation);
  const levels: Stats = { hp: 0, str: 0, agi: 0, def: 0 };
  const stats = {} as Record<StatKey, { xp: number; level: number; levelIfUncapped: number }>;
  for (const key of STAT_KEYS) {
    levels[key] = cappedLevel(xp[key], input.generation, input.tier);
    stats[key] = { xp: xp[key], level: levels[key], levelIfUncapped: Math.max(1, levelForXp(xp[key], scale)) };
  }
  const counted = receipts.filter(receipt => receipt.trainedAt !== undefined);
  const byGeneration: Record<string, number> = {};
  for (const receipt of counted) byGeneration[`gen${receipt.burnedGeneration}`] = (byGeneration[`gen${receipt.burnedGeneration}`] ?? 0) + 1;
  return {
    standard: "proof-of-burn", version: PROOF_OF_BURN_VERSION,
    friend: { id: input.friendId, generation: input.generation, ...(input.family ? { family: input.family } : {}) },
    tier: input.tier, cap: TIER_MAX_LEVEL[input.tier], stats,
    combat: {
      maxHp: maxHpFor(levels.hp), maxHit: maxHitFor(levels.str),
      attackSeconds: Math.round(attackCooldownMs(levels.agi)) / 1000,
      damageBlocked: defenceValueFor(levels.def), combatLevel: combatLevel(levels),
    },
    burns: { count: counted.length, totalXp: counted.reduce((sum, receipt) => sum + receipt.xp, 0), byGeneration },
    receipts: counted,
  };
}
