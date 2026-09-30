"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createClient, http, type PublicClient } from "viem";
import { getBlockNumber, getChainId, readContract } from "viem/actions";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { GymWorld, type GymStation } from "./gym-world";
import { VIEW, toView, worldRect, type RingGeometry } from "./gym-scene";
import { BurnRitual } from "./burn-ritual";
import {
  STAT_KEYS, TIER_MAX_LEVEL, attackCooldownMs, buildCharacterSheet, combatLevel, cumulativeXpForLevel, defenceValueFor,
  generationMultiplier as generationMultiplierNumber, levelForXp, makeReceipt, maxHitFor, maxHpFor, statXpFromReceipts,
  burnXp as xpForGeneration, trainingSecondsFor as secondsForGeneration,
  type BurnReceipt, type Generation as BurnGeneration, type StatKey, type Stats, type Tier,
} from "./proof-of-burn";
import type { EquipmentKind } from "./gym-equipment";
import { getWorldPreset, validateWorld, project, type WorldPoint } from "@rarefriends/friendsdk/world";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { createFriendSoundKit, type FriendSoundKit, type FriendSoundCue } from "@rarefriends/friendsdk/sounds";
import { GENERATION_SPRITE_MANIFEST, createGenerationSpriteReader, spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { readGenerationEligibility } from "@rarefriends/friendsdk/identity";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

/* ------------------------------------------------------------------------ *
 * Burning Gym — balance model
 *
 * FriendSDK v0.1.2 exposes only `friendId` + on-chain `generation` — there
 * is no "Tier" field anywhere in the SDK (see identity.ts). This game's
 * balance model deliberately DECOUPLES the two, matching the real Rare
 * Friends protocol docs (rarefriends.com/docs/generations):
 *
 *   - Tier is a paid, in-generation progression (Upgrade, tiers 0-4). Tier
 *     alone sets each stat's max level.
 *   - Generation is fixed on chain and never changes in this game (no
 *     Promote here). It drives two things: the "food chain" (which
 *     generations a Friend is allowed to burn) and, since a Gen 1 Friend is
 *     ~100,000x more valuable than a Gen 6 one, how much RF an Upgrade costs
 *     and how much XP each of its levels demands.
 *
 * One multiplier drives the whole economy, taken straight from the docs'
 * own Hardwire table (Gen 1 = 100,000 RF ... Gen 6 = 1 RF, exactly 10x per
 * step): generationMultiplier(1) = 100,000 down to generationMultiplier(6) = 1.
 *   - Burn XP value:        xpForGeneration(g)        = generationMultiplier(g)
 *   - XP needed per level:  quadratic, calibrated so ONE same-generation burn
 *     (which always grants exactly generationMultiplier(ownGen) XP) fully
 *     maxes a stat to level 100 — see cumulativeXpForLevel below.
 *   - Tier Upgrade RF cost: generationMultiplier(g) * 0.5 * 1.5^step — this
 *     is the docs' real "All upgrade prices" table, reproduced exactly
 *     (verified: Gen 1 step 0 = 50,000 RF, Gen 6 step 3 = 1.6875 RF, etc.)
 * ------------------------------------------------------------------------ */
const RF_DECIMALS = 18;
const RF_UNIT = 10n ** BigInt(RF_DECIMALS);

function generationMultiplierRf(generation: number): bigint { return 10n ** BigInt(Math.max(0, 6 - generation)); }

/** The docs' exact "All upgrade prices" formula: base * 1.5^step, base = generationMultiplier(g) * 0.5 RF. */
function tierUpgradeCost(generation: number, fromTier: 0 | 1 | 2 | 3): bigint {
  const numerator = generationMultiplierRf(generation) * RF_UNIT * (3n ** BigInt(fromTier));
  const denominator = 2n ** BigInt(fromTier + 1);
  return numerator / denominator;
}
/** Simulated demo balance: exactly enough $RF to buy every Tier upgrade for
 *  this generation (Tier 0 → 4), so the whole progression can be tried in a
 *  preview. There is no way to earn $RF in this build yet — the Arena and the
 *  other game modes that will pay out are planned (see the Game Modes menu). */
function demoBalanceForGeneration(generation: number): bigint {
  return ([0, 1, 2, 3] as const).reduce((sum, step) => sum + tierUpgradeCost(generation, step), 0n);
}

const STAT_LABEL: Record<StatKey, string> = { hp: "HP", str: "Strength", agi: "Agility", def: "Defence" };

/* The XP curve, burn XP, training times, Tier caps and combat numbers live in
 * proof-of-burn.ts, the shared module other games can reuse. */

/** Shows at most two units (s, m+s, or h+m) — whichever pair is relevant at that duration. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), remainderSeconds = seconds % 60;
  if (seconds < 3600) return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  const hours = Math.floor(seconds / 3600), remainderMinutes = Math.floor((seconds % 3600) / 60);
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

type BurnCandidate = Readonly<{ id: bigint; generation: BurnGeneration }>;
/** A training session: the burn receipts it will turn into stats once the timer ends. */
type Training = Readonly<{ statKey: StatKey; xp: number; totalSeconds: number; endsAt: number; receipts: readonly BurnReceipt[] }>;

/** Hex per generation, reused for the sacrifice-list portrait frame and as the
 *  burn shatter particles' starting colour — mirrors the food-chain palette
 *  already used for `.gym-pool-item[data-gen]` borders in style.css. Kept as
 *  a JS map (not read from CSS) because canvas fillStyle needs a real string. */
const GEN_COLOR: Record<BurnGeneration, string> = {
  1: "#ff7cff", 2: "#ff9fc9", 3: "#ffd88f", 4: "#d6b3ff", 5: "#8fd6ff", 6: "#cccccc",
};

/** A candidate mid-sacrifice: same identity as BurnCandidate, plus whatever
 *  sprite was already cached for it (or null if it never loaded — the burn
 *  effect falls back to a neutral silhouette rather than skip the animation). */
/** `id` is a string and `points` are plain numbers, not a GenerationSprites —
 *  see the SpritePoints comment near CandidateGlyph for why bigints never
 *  reach burn-effect state. */
type BurnFxCandidate = Readonly<{ id: string; generation: BurnGeneration; points: readonly { x: number; y: number }[] | null }>;
/** Snapshot taken once at confirmBurn() time: xp/totalSeconds are exactly what
 *  training will use once the animation finishes, so the animation itself can
 *  run entirely off this frozen data with no dependency on `pool`/`pickedCandidates`,
 *  which are already cleared by the time it plays. */
type BurnFx = Readonly<{
  statKey: StatKey;
  candidates: readonly BurnFxCandidate[];
  overflowCount: number;
  xp: number;
  totalSeconds: number;
  startedAt: number;
  durationMs: number;
  intensity: number;
  /** One proof-of-burn receipt per sacrificed Friend (including the ones folded into "+N"). */
  receipts: readonly BurnReceipt[];
}>;
const MAX_BURN_FX_PORTRAITS = 6;
/** Full sacrifice sequence (summon → ignite → burn → embers fly to the station):
 *  4.8 s when only Gen 6 Friends burn, up to 6.5 s when a Gen 1 is burned. Skippable. */
const BURN_DURATION_MS_MIN = 4800;
const BURN_DURATION_MS_MAX = 6500;
const BURN_REDUCED_DURATION_MS = 700;
type Menu = "sacrifice" | "modes" | "settings" | "help" | "upgrade" | "character" | "ring" | null;
/** The stat stations plus the Training Ring, which isn't tied to one single stat. */
type StationId = StatKey | "ring";

/* ------------------------------------------------------------------------ *
 * The Gym floor: a real walkable FriendSDK world (the "Circuit Courtyard"
 * preset, re-skinned) with one physical station per stat. Walking up to a
 * station and interacting (E / tap) is how you choose which stat to train —
 * that walk-over IS the stat choice, not a separate menu control.
 *
 * FriendSDK's canonical prop vocabulary is fixed (see friend-world.ts) and
 * has no literal gym equipment, so every station uses a custom machine
 * drawn in code instead (gym-equipment.ts) — the Vibeathon rules explicitly
 * allow bringing your own art. `prop: null` means the station adds no SDK
 * prop: GymWorld (gym-world.tsx) draws the machine on the world canvas,
 * depth-sorted with the Friend, and an invisible `gym-station-icon` button
 * over it keeps it clickable.
 * ------------------------------------------------------------------------ */
/** labelOffset clears each machine's tallest point (see gym-equipment.ts) so the
 *  "Walk closer / E to train" prompt never overlaps the custom art standing under it. */
const STATIONS: Record<StatKey, { label: string; position: WorldPoint; prop: "crate" | "bridge" | "tank" | "crystal" | null; labelOffset: number }> = {
  str: { label: "Barbell Rack", position: [70, 250], prop: null, labelOffset: -150 },
  agi: { label: "Sprint Track", position: [545, 200], prop: null, labelOffset: -140 },
  hp: { label: "Recovery Bike", position: [280, 12], prop: null, labelOffset: -172 },
  def: { label: "Boxing Reflex Trainer", position: [300, 372], prop: null, labelOffset: -150 },
};
/** The preset's central courtyard was a real `hole` — unwalkable void, not just
 *  empty ground — which forced every walk to detour around it. Closing the
 *  hole turns that whole square into ordinary walkable floor so the Training
 *  Ring below can actually be walked onto, not just decorated around. */
const gymPreset = getWorldPreset("02-circuit-courtyard-complete");
const RING_STATION = { id: "ring" as const, label: "Training Ring", position: [288, 192] as WorldPoint, labelOffset: -128 };
/** The ring is a real square on the floor grid, centred on its station point. */
const RING: RingGeometry = { center: RING_STATION.position, half: 58 };
/** The walkable room is the SDK preset's own octagon, with its central hole
 *  closed (see above) and its scattered props removed: GymWorld paints its
 *  own "neon basement" set dressing (gym-scene.ts), and SDK props would
 *  otherwise leave invisible collision blocks where nothing is drawn. */
const world = validateWorld({
  ...gymPreset,
  geometry: { ...gymPreset.geometry, holes: [] },
  props: [],
  actors: [],
});
const spawn: WorldPoint = [288, 300];
function stationPosition(id: StationId): WorldPoint {
  return id === "ring" ? RING_STATION.position : STATIONS[id].position;
}
/** Stat colours shared by the HUD bars, the station mats and the prompts. */
const STAT_COLOR: Record<StatKey, string> = { hp: "#ff5e5e", str: "#ffb85e", agi: "#5ef0ff", def: "#c85eff" };
/** Machine at each station, drawn in code by gym-equipment.ts (same style as
 *  the room; each one animates, with the Friend using it, while that stat trains). */
const STATION_EQUIPMENT: Record<StatKey, EquipmentKind> = { str: "barbell", agi: "treadmill", hp: "bike", def: "reflex" };
/** World-space mats under each station (clipped to the floor where they meet the walls). */
const STATION_ZONE: Record<StatKey, WorldPoint[]> = {
  str: worldRect(82, 250, 46, 64), agi: worldRect(545, 204, 42, 64), hp: worldRect(280, 26, 58, 34), def: worldRect(290, 362, 58, 30),
};
const GYM_STATIONS: readonly GymStation[] = [
  ...STAT_KEYS.map(key => ({
    id: key, label: `${STATIONS[key].label} · ${STAT_LABEL[key]}`, action: "E / tap to train", position: STATIONS[key].position,
    reach: 70, labelOffset: STATIONS[key].labelOffset, color: STAT_COLOR[key], zone: STATION_ZONE[key], equipment: STATION_EQUIPMENT[key],
  })),
  { id: RING_STATION.id, label: RING_STATION.label, action: "E / tap to spar", position: RING_STATION.position, reach: 90,
    labelOffset: RING_STATION.labelOffset, color: "#7cff5e", zone: worldRect(RING.center[0], RING.center[1], RING.half, RING.half) },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A simulated pool of "lesser" Friends available to burn (the SDK has no
 *  burn/transfer action — this MVP mocks the pool per the brief). Six of
 *  every generation your Friend is allowed to eat (food chain), so a Gen 1
 *  Friend still gets some own-tier fodder instead of only Gen 6 scraps, and
 *  there's enough volume to make multi-select burning worthwhile. */
const CANDIDATES_PER_GENERATION = 6;
function makeSacrificePool(seed: number, playerGeneration: number): BurnCandidate[] {
  const rand = mulberry32(seed);
  const start = Math.max(1, Math.min(6, playerGeneration)) as BurnGeneration;
  const generations: BurnGeneration[] = [];
  for (let g = start; g <= 6; g++) for (let i = 0; i < CANDIDATES_PER_GENERATION; i++) generations.push(g as BurnGeneration);
  return generations.map(generation => ({ id: BigInt(2_000 + Math.floor(rand() * 88_000)), generation }));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Combat Engine: one OSRS-style hit-chance / damage-reduction loop shared by
 * the Training Ring (ticked out live, see the ring battle effect below) and,
 * later, the planned game modes (see the Game Modes menu). A
 * Combatant only holds the derived fighting numbers (Agility, Max Hit,
 * Defence); current/max HP is tracked separately by each mode since it
 * changes over the course of a fight.
 *
 * Defence's combat value is level - 1 (so level 1 -> 0 reduction) while HP,
 * Strength and Agility all use their level directly — an untrained Friend
 * has no trained toughness yet, but still has a nonzero body/power/speed.
 */
type Combatant = Readonly<{ agility: number; maxHit: number; defence: number }>;
function combatantFor(stats: Stats): Combatant {
  return { agility: stats.agi, maxHit: maxHitFor(stats.str), defence: defenceValueFor(stats.def) };
}
type AttackResult = Readonly<{ hit: boolean; damage: number }>;
function resolveAttack(attacker: Combatant, defender: Combatant): AttackResult {
  const hitChance = clamp(50 + (attacker.agility - defender.agility) * 0.5, 20, 90);
  if (Math.random() * 100 > hitChance) return { hit: false, damage: 0 };
  const rawDamage = 1 + Math.floor(Math.random() * attacker.maxHit);
  return { hit: true, damage: Math.max(1, rawDamage - defender.defence) };
}

/**
 * Combat log lines: a plain flavor sentence, plus (for a landed hit only) the
 * damage dealt and the defender's HP right after it — rendered separately so
 * the damage number alone can be styled red, and the varied phrasing keeps
 * repeated fights from reading identically every time.
 */
type CombatLine = Readonly<{ text: string; damage?: Readonly<{ amount: number; hpAfter: number; hpMax: number }> }>;
function pick<T>(items: readonly T[]): T { return items[Math.floor(Math.random() * items.length)]; }
const HIT_TEMPLATES = [
  "{a} catches {d} with a sharp jab to the {p}.",
  "{a} lands a heavy blow square on {d}'s {p}.",
  "{a} drives a punch straight into {d}'s {p}.",
  "{a} cracks a solid hit across {d}'s {p}.",
  "{a} times it perfectly and slams {d} in the {p}.",
  "{a} gets through {d}'s guard with a shot to the {p}.",
  "{a} winds up and connects clean on {d}'s {p}.",
  "{a} steps in and hammers {d}'s {p}.",
] as const;
const MISS_TEMPLATES = [
  "{a} swings, but {d} ducks out of the way.",
  "{a} throws a punch — {d} slips it clean.",
  "{a} lunges in, but {d} blocks at the last second.",
  "{a} tries to close the gap, but {d} sidesteps.",
  "{a} telegraphs the strike and {d} deflects it.",
  "{a} overreaches — {d} weaves out of range.",
  "{a} commits to the swing, but {d} catches the arm and shrugs it off.",
  "{a} feints high, but {d} reads it and steps clear.",
] as const;
const BODY_PARTS = ["ribs", "jaw", "shoulder", "gut", "temple", "chest", "arm", "side", "chin", "collarbone"] as const;
function fillTemplate(template: string, attacker: string, defender: string): string {
  return template.replace("{a}", attacker).replace(/\{d\}/g, defender).replace("{p}", pick(BODY_PARTS));
}
function buildAttackLine(attacker: string, defender: string, result: AttackResult, hpAfter: number, hpMax: number): CombatLine {
  if (!result.hit) return { text: fillTemplate(pick(MISS_TEMPLATES), attacker, defender) };
  return { text: fillTemplate(pick(HIT_TEMPLATES), attacker, defender), damage: { amount: result.damage, hpAfter, hpMax } };
}


/**
 * Training Ring: a free, repeatable practice bout against a dummy, using the
 * Combat Engine the planned game modes will use — Strength sets Max Hit, HP sets Max
 * HP, Agility drives hit chance and attack speed, and Defence cuts down
 * incoming damage. No $RF or XP is at stake; it's purely a feel for your
 * current build. Walking onto the ring only opens a picker for the dummy's
 * weight class (a Tier preset, maxed at that Tier's cap in all four stats,
 * same as a fully-trained Friend of that Tier) — the fight itself only starts
 * once "Start Training" is pressed.
 */
type RingBattle = Readonly<{
  dummyTier: Tier; dummyLevels: Stats;
  playerHp: number; playerMaxHp: number; dummyHp: number; dummyMaxHp: number;
  log: readonly CombatLine[]; nextPlayerAttackAt: number; nextDummyAttackAt: number;
  outcome: "fighting" | "win" | "lose";
}>;

/** Turns a sprite's 16x16 "#"/"." bitmap rows into a flat opaque-pixel list —
 *  shared by the SVG portrait path builder, the burn candidate glyph and the
 *  burn shatter canvas, so all three agree on exactly which cells are "lit". */
function bitmapPixels(rows: readonly string[]): readonly { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "#") points.push({ x, y }); });
  return points;
}
function pixelsToSvgPath(points: readonly { x: number; y: number }[]): string {
  return points.map(({ x, y }) => `M${x} ${y}h1v1h-1z`).join("");
}
/** Procedural placeholder (a round head + body blob, in the same 16x16 grid as
 *  a real sprite) for a burn candidate whose on-chain sprite never loaded —
 *  keeps the sacrifice-list portrait and the burn effect from ever depending
 *  on a successful RPC read (see CandidatePortrait / BurnRitual). */
const SILHOUETTE_PIXELS: readonly { x: number; y: number }[] = (() => {
  const points: { x: number; y: number }[] = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const inHead = y < 6 && Math.hypot(x - 8, (y - 3) * 1.3) < 3;
      const inBody = y >= 5 && y <= 14 && Math.abs(x - 8) < 4.2 - (y - 5) * 0.15;
      if (inHead || inBody) points.push({ x, y });
    }
  }
  return points;
})();

/** Real on-chain sprite (idle, facing down) — used for the HUD portrait button and character sheet.
 *  This is the SDK's canonical art for the player's OWN Friend and is never touched by the burn
 *  effects below — only sacrifice candidates (never the player) get the fire/shatter treatment. */
function SpritePortrait({ sprites, className = "" }: { sprites: GenerationSprites; className?: string }) {
  const { frame } = spriteFrame(sprites, "down", false, 0);
  const path = pixelsToSvgPath(bitmapPixels(frame.rows));
  return <svg className={`gym-sprite ${className}`.trim()} viewBox="0 0 16 16" shapeRendering="crispEdges" fill="currentColor"
    role="img" aria-label={`${sprites.familyName} Friend portrait`}><path d={path} /></svg>;
}

/** A sprite's opaque pixels, plain numbers only (no bigint anywhere) — what
 *  both CandidateGlyph and the BurnRitual effect actually need to draw. Derived
 *  once from a GenerationSprites and never held onto past that: React's dev
 *  build profiles slow-committing components by diffing their props/state,
 *  and a BigInt anywhere in that diff (a raw GenerationSprites has one at
 *  `tokenId` plus 64 more in `frames`) crashes that profiler hard enough to
 *  corrupt the whole page's reconciler — see the SpritePoints indirection
 *  below and the state types in CandidatePortrait/BurnFxCandidate. */
type SpritePoints = readonly { x: number; y: number }[];
function spritePoints(sprites: GenerationSprites): SpritePoints {
  return bitmapPixels(spriteFrame(sprites, "down", false, 0).frame.rows);
}

/** Same pixel-glyph rendering as SpritePortrait, but for a burn candidate:
 *  colored per generation (see GEN_COLOR) instead of `currentColor`, and
 *  falls back to the neutral SILHOUETTE_PIXELS blob when no sprite is
 *  available yet (still loading, or the read failed) — used by both the
 *  sacrifice list thumbnail and the burn effect's ignite phase. Takes
 *  pre-extracted points rather than a GenerationSprites (see SpritePoints). */
function CandidateGlyph({ points, generation, className = "" }: { points: SpritePoints | null; generation: BurnGeneration; className?: string }) {
  const path = pixelsToSvgPath(points ?? SILHOUETTE_PIXELS);
  return <svg className={`gym-sprite ${className}`.trim()} viewBox="0 0 16 16" shapeRendering="crispEdges"
    fill={GEN_COLOR[generation]} aria-hidden="true"><path d={path} /></svg>;
}

/** The raw on-chain sprite lives ONLY in this ref-backed cache (never in
 *  React state), keyed by the candidate's id as a string — a ref's contents
 *  don't get diffed by React's dev-mode profiler the way state does, so this
 *  is the one place a GenerationSprites (bigint tokenId + 64 bigint frames)
 *  is safe to hold onto. Components read out of it and keep only the plain-
 *  number SpritePoints derived above. */
type SpriteCache = Map<string, GenerationSprites | "error">;

/** Lazily fetches and caches one sacrifice candidate's on-chain sprite the
 *  first time its row scrolls into view inside the (up to 36-item) pool
 *  list, instead of firing every candidate's read the moment the menu opens.
 *  The cache is a ref owned by the parent component, so it survives re-opens
 *  of the menu and is also what confirmBurn() reads from when it snapshots
 *  the burn effect's portraits — no separate fetch needed there. `id` is a
 *  string, not a bigint (see SpritePoints) — the caller already has both. */
function CandidatePortrait({ id, generation, spriteReader, cache }: {
  id: string; generation: BurnGeneration;
  spriteReader: ReturnType<typeof createGenerationSpriteReader>;
  cache: { current: SpriteCache };
}) {
  const [points, setPoints] = useState<SpritePoints | "error" | null>(() => {
    const cached = cache.current.get(id);
    return cached ? (cached === "error" ? "error" : spritePoints(cached)) : null;
  });
  const elementRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (points) return;
    const element = elementRef.current;
    if (!element) return;
    const root = element.closest(".gym-pool");
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      const cached = cache.current.get(id);
      if (cached) { setPoints(cached === "error" ? "error" : spritePoints(cached)); return; }
      spriteReader.read(BigInt(id))
        .then(result => { cache.current.set(id, result); setPoints(spritePoints(result)); })
        .catch(() => { cache.current.set(id, "error"); setPoints("error"); });
    }, { root: root instanceof Element ? root : null, rootMargin: "200px", threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, points, spriteReader, cache]);

  return <span ref={elementRef} className="gym-pool-portrait">
    <CandidateGlyph points={points && points !== "error" ? points : null} generation={generation} className="gym-sprite" />
  </span>;
}

/**
 * The sacrifice's actual "burn". Full motion: BurnRitual (burn-ritual.tsx) —
 * the chosen Friends are summoned onto burning grates, catch fire, burn away
 * pixel by pixel into embers, and the embers stream into the chosen station.
 * Reduced motion: the same Friends simply fade out, no flicker or particles.
 * Purely visual — confirmBurn() already removed the candidates from the pool
 * and captured the xp/seconds it needs; the parent starts training when the
 * effect's time is up (or immediately when the player skips).
 */
function BurnEffectsOverlay({ fx, reducedMotion, onCue, onSkip }: {
  fx: BurnFx; reducedMotion: boolean; onCue: (cue: FriendSoundCue) => void; onSkip: () => void;
}) {
  if (reducedMotion) {
    return <div className="gym-burn-fx-reduced" aria-hidden="true">
      <div className="gym-burn-row">
        {fx.candidates.map(candidate => <span key={candidate.id} className="gym-burn-reduced-item">
          <CandidateGlyph points={candidate.points} generation={candidate.generation} className="gym-burn-sprite" />
        </span>)}
        {fx.overflowCount > 0 && <span className="gym-burn-overflow">+{fx.overflowCount}</span>}
      </div>
    </div>;
  }
  const target = toView(...STATIONS[fx.statKey].position);
  return <BurnRitual
    candidates={fx.candidates.map(candidate => ({ id: candidate.id, generation: candidate.generation,
      color: GEN_COLOR[candidate.generation], points: candidate.points ?? SILHOUETTE_PIXELS }))}
    overflowCount={fx.overflowCount} intensity={fx.intensity} durationMs={fx.durationMs}
    target={[target[0], target[1] - 30]} statLabel={STAT_LABEL[fx.statKey]} statColor={STAT_COLOR[fx.statKey]} xp={fx.xp}
    onCue={onCue} onSkip={onSkip} />;
}

/** Shared renderer for CombatLine[] — the damage amount is its own styled span
 *  (red, matching a "successful hit" convention) instead of being baked into
 *  the sentence, and the defender's post-hit HP trails it in dim grey. */
function CombatLogList({ lines }: { lines: readonly CombatLine[] }) {
  return <ol className="gym-combat-log">
    {lines.map((line, index) => <li key={index}>
      {line.text}
      {line.damage && <> <strong className="gym-damage">-{line.damage.amount}</strong> <span className="gym-damage-hp">({line.damage.hpAfter}/{line.damage.hpMax})</span></>}
    </li>)}
  </ol>;
}

/**
 * Whole-career progress (level 0-100 split into 5 Tier-sized segments). With
 * just `currentLevel`, this is the plain "where am I" bar (Character sheet).
 * Passing `projectedLevel` too (Sacrifice menu) adds an amber "preview" layer
 * showing how far a burn would carry the stat — including past the lock on
 * a not-yet-unlocked segment, to make the scale of banked XP visible without
 * implying that reach is actually usable before the next Tier upgrade.
 */
function TierProgressBar({ tier, statKey, currentLevel, projectedLevel }: { tier: Tier; statKey: StatKey; currentLevel: number; projectedLevel?: number }) {
  const preview = projectedLevel ?? currentLevel;
  return <div className="gym-tier-bar" data-stat={statKey} role="img"
    aria-label={`Tier progress: Tier ${tier} of 4 unlocked, level ${currentLevel}${preview > currentLevel ? ` (projected ${preview})` : ""}`}>
    {TIER_MAX_LEVEL.map((_, segment) => {
      const unlocked = segment <= tier;
      const segmentStart = segment * 20;
      const currentFill = unlocked ? clamp(((currentLevel - segmentStart) / 20) * 100, 0, 100) : 0;
      const previewFill = clamp(((preview - segmentStart) / 20) * 100, 0, 100);
      return <div key={segment} className="gym-tier-segment" data-unlocked={unlocked} data-active={segment === tier}>
        {previewFill > 0 && <div className="gym-tier-preview-fill" style={{ width: `${previewFill}%` }} />}
        {unlocked && currentFill > 0 && <div className="gym-stat-fill" style={{ width: `${currentFill}%` }} />}
        {!unlocked && <span className="gym-tier-lock" aria-hidden="true">🔒</span>}
      </div>;
    })}
  </div>;
}

/* ------------------------------------------------------------------------ *
 * Combat readouts: what a stat level actually means in a fight, straight
 * from the Combat Engine (maxHpFor / maxHitFor / attackCooldownMs /
 * defenceValueFor), so the HUD and character sheet show real fighting
 * numbers instead of raw level bars.
 * ------------------------------------------------------------------------ */
type StatReadout = Readonly<{ value: string; unit: string; short: string }>;
function statReadout(key: StatKey, level: number): StatReadout {
  switch (key) {
    case "hp": { const hp = maxHpFor(level); return { value: `${hp}`, unit: "max HP", short: `${hp} HP` }; }
    case "str": { const hit = maxHitFor(level); return { value: `${hit}`, unit: "max hit", short: `Hit ${hit}` }; }
    case "agi": { const seconds = (attackCooldownMs(level) / 1000).toFixed(2); return { value: `${seconds}s`, unit: "per attack", short: `${seconds}s` }; }
    case "def": { const block = defenceValueFor(level); return { value: block > 0 ? `−${block}` : "0", unit: "dmg taken", short: `Block ${block}` }; }
  }
}
/** What the next meaningful level buys, e.g. "Lv 18 → max hit 10". Strength only
 *  gains Max Hit every other level, so this looks ahead to the next level that
 *  actually changes the number; returns null once that is beyond the Tier cap. */
function nextStatGain(key: StatKey, level: number, cap: number): string | null {
  const now = statReadout(key, level).value;
  for (let next = level + 1; next <= cap; next++) {
    const readout = statReadout(key, next);
    if (readout.value === now) continue;
    switch (key) {
      case "hp": return `Lv ${next} → ${readout.short}`;
      case "str": return `Lv ${next} → max hit ${readout.value}`;
      case "agi": return `Lv ${next} → ${readout.value} per attack`;
      case "def": return `Lv ${next} → blocks ${defenceValueFor(next)} dmg`;
    }
  }
  return null;
}

/** 8 × 8 pixel icons, one per stat, in that stat's colour. */
const STAT_ICON_ROWS: Record<StatKey, readonly string[]> = {
  hp: ["........", ".##.##..", "#######.", "#######.", ".#####..", "..###...", "...#....", "........"],
  str: ["......##", ".....###", "....###.", "#..###..", ".####...", "..##....", ".#.#....", "#......."],
  agi: ["....##..", "...##...", "..##....", ".######.", "....##..", "...##...", "..##....", ".#......"],
  def: ["########", "########", "########", "########", ".######.", ".######.", "..####..", "...##..."],
};
function StatIcon({ statKey, size = 14 }: { statKey: StatKey; size?: number }) {
  return <svg className="gym-stat-icon" data-stat={statKey} width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
    <path d={pixelsToSvgPath(bitmapPixels(STAT_ICON_ROWS[statKey]))} />
  </svg>;
}

/** HUD unit frame: portrait with Combat Level, name, HP bar, and the other
 *  three stats as their real fighting numbers. Opens the character sheet. */
function UnitFrame({ sprites, friendId, generation, tier, cap, levels, training, onOpen }: {
  sprites: GenerationSprites | null; friendId: bigint; generation: number | null; tier: Tier; cap: number;
  levels: Stats; training: StatKey | null; onOpen: () => void;
}) {
  const maxHp = maxHpFor(levels.hp);
  return <button type="button" className="gym-unit" onClick={onOpen}
    aria-label={`Character sheet. Combat level ${combatLevel(levels)}, ${maxHp} HP, max hit ${maxHitFor(levels.str)}, ${statReadout("agi", levels.agi).value} per attack, blocks ${defenceValueFor(levels.def)} damage.`}>
    <span className="gym-unit-portrait">
      {sprites ? <SpritePortrait sprites={sprites} /> : <span className="gym-portrait-placeholder" aria-hidden="true">?</span>}
      <span className="gym-unit-cl">CL {combatLevel(levels)}</span>
    </span>
    <span className="gym-unit-body">
      <span className="gym-unit-name">{sprites?.familyName ?? "Friend"} #{friendId.toString()}</span>
      <span className="gym-unit-sub">GEN {generation ?? "…"} · TIER {tier} · CAP {cap}</span>
      <span className="gym-unit-hp" data-training={training === "hp" || undefined}><span className="gym-unit-hp-fill" /><span className="gym-unit-hp-text">{maxHp} / {maxHp} HP</span></span>
      <span className="gym-unit-stats">
        {(["str", "agi", "def"] as const).map(key => {
          const readout = statReadout(key, levels[key]);
          return <span key={key} className="gym-unit-stat" data-stat={key} data-training={training === key || undefined}>
            <StatIcon statKey={key} />{readout.value}<small>{readout.unit}</small>
          </span>;
        })}
      </span>
    </span>
  </button>;
}

/** The machines themselves are drawn on GymWorld's canvas (gym-equipment.ts);
 *  each station button is an invisible click target sized to its machine
 *  (see `.gym-station-icon[data-stat]` in style.css). */
function StationHitArea() {
  return <span className="gym-station-hit" aria-hidden="true" />;
}

/** Same three-layer flame as the burning showers, standalone for reuse on the wall sign. */
function FlameIcon({ className }: { className?: string }) {
  return <svg viewBox="-14 -26 28 36" className={className} aria-hidden="true">
    <path d="M0-24Q13-8 0 10Q-13-8 0-24Z" fill="#c62800" />
    <path d="M0-19Q9-8 0 6Q-9-8 0-19Z" fill="#ff5e1a" />
    <path d="M0-12Q5-6 0 2Q-5-6 0-12Z" fill="#ffd23f" />
  </svg>;
}

/**
 * Proof of Burn card, styled after the Rare Friends portfolio: stat boxes on
 * white, then a black strip with the most recently burned Friends (their real
 * sprites when already loaded, a neutral silhouette otherwise).
 */
function ProofOfBurnCard({ friendId, family, generation, tier, burned, xp, combatLevel: cl, byGeneration, latest }: {
  friendId: string; family?: string; generation: number | null; tier: Tier; burned: number; xp: number; combatLevel: number;
  byGeneration: readonly (readonly [number, number])[];
  latest: readonly { id: string; generation: number; points: SpritePoints | null }[];
}) {
  const more = burned - latest.length;
  return <div className="gym-pob-card" role="group" aria-label="Proof of burn card">
    <div className="gym-pob-head">
      <div><span className="gym-pob-kicker">RARE FRIENDS</span><strong className="gym-pob-title">PROOF OF BURN</strong></div>
      <span className="gym-pob-id">[ {family ?? "Friend"} #{friendId} · Gen {generation ?? "…"} ]</span>
    </div>
    <div className="gym-pob-boxes">
      <div><small>Friends burned</small><b>{burned.toLocaleString("en-US")}</b></div>
      <div><small>XP gained</small><b>{xp.toLocaleString("en-US")}</b></div>
      <div><small>Hardwire burned</small><b>{xp.toLocaleString("en-US")}</b><em>RF of burned NFT value</em></div>
      <div className="gym-pob-dark"><small>Combat Level</small><b>{cl}</b><em>Tier {tier} · cap {TIER_MAX_LEVEL[tier]}</em></div>
    </div>
    <div className="gym-pob-strip">
      <div className="gym-pob-friends">
        {latest.map((friend, index) => <figure key={`${friend.id}-${index}`}>
          <svg viewBox="0 0 16 16" shapeRendering="crispEdges" fill="#fff" aria-hidden="true"><path d={pixelsToSvgPath(friend.points ?? SILHOUETTE_PIXELS)} /></svg>
          <figcaption><span><i />Gen-{friend.generation}</span><span>#{friend.id}</span></figcaption>
        </figure>)}
        {more > 0 && <figure className="gym-pob-more"><span>+{more}</span><figcaption>more</figcaption></figure>}
      </div>
      <div className="gym-pob-summary">
        <strong>{burned} BURNED</strong>
        <span>{byGeneration.map(([g, n]) => `${n} × Gen ${g}`).join(" · ")}</span>
        <span>since last transfer · resets on sale</span>
      </div>
    </div>
  </div>;
}

/** Shown on every info screen: the stats are a preview system, not a finished game economy. */
function PreviewNote() {
  return <p className="gym-preview-note"><strong>Preview stats.</strong> Character stats are preliminary: a shared base for future Rare Friends mini-games. Everything here, including $RF, is simulated.</p>;
}

/* ------------------------------------------------------------------------ *
 * Game Modes: placeholders for the modes that will use these stats. Nothing
 * here is playable yet; each card is drawn in code (pixel icon on a neon
 * panel) in the same style as the gym.
 * ------------------------------------------------------------------------ */
type GameModeId = "pvp" | "pve" | "tournament" | "raid";
const GAME_MODES: readonly { id: GameModeId; title: string; text: string; uses: string }[] = [
  { id: "pvp", title: "PvP Arena", text: "1v1 duels against other players' Friends, with $RF entry fees and prize pots.", uses: "all four stats" },
  { id: "pve", title: "PvE Dungeons", text: "Fight through rooms of monsters and bring loot back to the gym.", uses: "HP · Strength · Defence" },
  { id: "tournament", title: "Tier Tournaments", text: "Brackets per Tier: micro-tournaments, mid and elite leagues, Battle Royale.", uses: "Tier · Combat Level" },
  { id: "raid", title: "Boss Raids", text: "Team up with other Friends against a giant boss.", uses: "Strength · Agility" },
];
const GAME_MODE_ART: Record<GameModeId, { color: string; rows: readonly string[] }> = {
  pvp: { color: "#ff5e5e", rows: ["#..........#", ".#........#.", "..#......#..", "...#....#...", "....#..#....", ".....##.....", ".....##.....", "....#..#....", "..###..###..", "...#....#...", "..#......#..", ".#........#."] },
  pve: { color: "#5ef0ff", rows: ["....####....", "..##....##..", ".#........#.", ".#..####..#.", "#..#....#..#", "#..#....#..#", "#..#..#.#..#", "#..#....#..#", "#..#....#..#", "#..#....#..#", "############", "............"] },
  tournament: { color: "#ffd23f", rows: ["############", "#.########.#", "#.########.#", ".#.######.#.", "...######...", "....####....", ".....##.....", ".....##.....", "....####....", "...######...", "...######...", "............"] },
  raid: { color: "#c85eff", rows: ["...######...", "..########..", ".##########.", ".#..####..#.", ".#..####..#.", ".##########.", "..###..###..", "...######...", "...#.##.#...", "...######...", "............", "............"] },
};
function GameModeArt({ mode }: { mode: GameModeId }) {
  const { color, rows } = GAME_MODE_ART[mode];
  return <svg viewBox="0 0 160 90" className="gym-mode-svg" aria-hidden="true">
    <rect width="160" height="90" fill="#0c0c14" />
    <path d="M0 70 L80 50 L160 70 M0 82 L80 58 L160 82 M40 90 L80 50 L120 90" stroke={color} strokeOpacity={0.25} fill="none" />
    <g transform="translate(50 12) scale(5)" fill={color} shapeRendering="crispEdges" style={{ filter: `drop-shadow(0 0 1px ${color})` }}>
      <path d={pixelsToSvgPath(bitmapPixels(rows))} />
    </g>
  </svg>;
}

/** Read-only RPC client with just the calls the gym needs (ownership, generation, artwork).
 *  Mirrors FriendSDK v0.1.4's createFriendReadClient (not a public export), so the bundle
 *  carries no transaction-capable viem actions. */
type GymReadClient = Pick<PublicClient, "getBlockNumber" | "getChainId" | "readContract">;
function createGymReadClient(rpcUrl: string): GymReadClient {
  const rpc = createClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 12_000 }), cacheTime: 0, pollingInterval: 1_000 });
  return {
    getBlockNumber: parameters => getBlockNumber(rpc, parameters),
    getChainId: () => getChainId(rpc),
    readContract: parameters => readContract(rpc, parameters),
  } as GymReadClient;
}

export default function BurningGym({ friendId, client, paused }: GameComponentProps) {
  const publicClient = useMemo(() => createGymReadClient(GENERATION_SPRITE_MANIFEST.rpcUrl), []);
  const spriteReader = useMemo(() => createGenerationSpriteReader(publicClient), [publicClient]);

  const [generation, setGeneration] = useState<number | null>(null);
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const [genError, setGenError] = useState("");
  const [genRetry, setGenRetry] = useState(0);

  const [tier, setTier] = useState<Tier>(0);
  // Proof of burn: stats are never stored directly. They are derived from the
  // burn receipts of finished trainings (see proof-of-burn.ts).
  const [receipts, setReceipts] = useState<readonly BurnReceipt[]>([]);
  const statXp = useMemo<Stats>(() => statXpFromReceipts(receipts), [receipts]);
  const [showSheetJson, setShowSheetJson] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [training, setTraining] = useState<Training | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [pool, setPool] = useState<BurnCandidate[]>([]);
  const [pickedCandidates, setPickedCandidates] = useState<ReadonlySet<bigint>>(new Set());
  const [activeStat, setActiveStat] = useState<StatKey | null>(null);
  const [burnFx, setBurnFx] = useState<BurnFx | null>(null);
  const spriteCacheRef = useRef<SpriteCache>(new Map());

  const [rf, setRf] = useState(0n);
  const demoFunded = useRef(false);
  const [ringDummyTier, setRingDummyTier] = useState<Tier>(0);
  const [ringBattle, setRingBattle] = useState<RingBattle | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [message, setMessage] = useState("");

  const [muted, setMuted] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const sound = useRef<FriendSoundKit | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const walkTarget = useRef<StationId | null>(null);
  const [hoveredStation, setHoveredStation] = useState<StationId | null>(null);

  const cap = TIER_MAX_LEVEL[tier];
  const xpScale = generation === null ? 1 : generationMultiplierNumber(generation);
  // Displayed level is XP-derived, floored at 1 (a Friend's stats are never
  // truly zero) and clamped to the current Tier's cap; XP banked past the
  // cap isn't lost, it's just inert until the next upgrade.
  const levels: Stats = { hp: Math.max(1, Math.min(cap, levelForXp(statXp.hp, xpScale))), str: Math.max(1, Math.min(cap, levelForXp(statXp.str, xpScale))),
    agi: Math.max(1, Math.min(cap, levelForXp(statXp.agi, xpScale))), def: Math.max(1, Math.min(cap, levelForXp(statXp.def, xpScale))) };
  // Combat logs name both fighters — the family name reads as this NFT's closest thing to a
  // proper name, alongside its token number, matching how burn candidates are already named.
  const playerName = sprites ? `${sprites.familyName} #${friendId.toString()}` : `Friend #${friendId.toString()}`;
  // `tier < 4` doesn't narrow Tier's type for TypeScript, so tierUpgradeCost's
  // 0|1|2|3 `fromTier` param needs an explicit narrowed value, computed once.
  const nextTier: 0 | 1 | 2 | 3 | null = tier < 4 ? (tier as 0 | 1 | 2 | 3) : null;

  useEffect(() => {
    let cancelled = false;
    setGenError("");
    Promise.all([readGenerationEligibility(publicClient, friendId), spriteReader.read(friendId)])
      .then(([result, spriteResult]) => {
        if (cancelled) return;
        setGeneration(result.generation);
        // One-time simulated demo balance, so every Tier upgrade can be tried (see demoBalanceForGeneration).
        if (!demoFunded.current) { demoFunded.current = true; setRf(demoBalanceForGeneration(result.generation)); }
        setSprites(spriteResult);
        setPool(makeSacrificePool(Number(friendId % 2n ** 31n) ^ (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0), result.generation));
      })
      .catch(cause => { if (!cancelled) setGenError(cause instanceof Error ? cause.message : "Could not verify this Friend."); });
    return () => { cancelled = true; };
  }, [publicClient, spriteReader, friendId, genRetry]);

  useEffect(() => {
    sound.current = createFriendSoundKit({ muted: true });
    return () => { sound.current?.dispose(); sound.current = null; };
  }, []);

  /** The SDK host's loading overlay only clears once the game calls client.read()
   *  over the postMessage bridge (see frame-bridge.ts). This MVP's economy is its
   *  own local state, but this call is still required to complete the handshake. */
  useEffect(() => { void client.read().catch(() => {}); }, [client]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!training) { setRemaining(0); return; }
    const tick = () => {
      const left = Math.max(0, Math.ceil((training.endsAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        const trainedAt = Date.now();
        setReceipts(prev => [...prev, ...training.receipts.map(receipt => ({ ...receipt, trainedAt }))]);
        setMessage(`Training complete — ${STAT_LABEL[training.statKey]} +${training.xp} XP!`);
        sound.current?.play("action-ready");
        setTraining(null);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [training]);

  // Lets the burn effect (ignite + shatter, see BurnEffectsOverlay) play to
  // completion before the actual training timer starts — xp/totalSeconds were
  // already captured at confirmBurn() time, this just delays applying them by
  // the animation's own duration (reducedMotion shortens it, doesn't skip it).
  useEffect(() => {
    if (!burnFx) return;
    const delay = Math.max(0, burnFx.startedAt + burnFx.durationMs - Date.now());
    const id = window.setTimeout(() => {
      const count = burnFx.candidates.length + burnFx.overflowCount;
      setTraining({ statKey: burnFx.statKey, xp: burnFx.xp, totalSeconds: burnFx.totalSeconds, endsAt: Date.now() + burnFx.totalSeconds * 1000, receipts: burnFx.receipts });
      setMessage(`${count} Friend${count > 1 ? "s" : ""} sacrificed. Training ${STAT_LABEL[burnFx.statKey]} at the ${STATIONS[burnFx.statKey].label}…`);
      sound.current?.play("reward");
      setBurnFx(null);
    }, delay);
    return () => window.clearTimeout(id);
  }, [burnFx]);

  // Ticks the Training Ring bout: each side attacks on its own independent
  // clock (paced by its own Agility via attackCooldownMs), checked frequently
  // enough to feel real-time without needing a full per-frame loop. Both
  // sides resolve hits with the exact same resolveAttack Combat Engine step —
  // the dummy is just a Stats block too.
  useEffect(() => {
    if (!ringBattle || ringBattle.outcome !== "fighting") return;
    const id = setInterval(() => {
      setRingBattle(prev => {
        if (!prev || prev.outcome !== "fighting") return prev;
        const now = Date.now();
        let { playerHp, dummyHp, nextPlayerAttackAt, nextDummyAttackAt } = prev;
        const log = [...prev.log];
        const player = combatantFor(levels), dummy = combatantFor(prev.dummyLevels);
        const dummyName = `Tier ${prev.dummyTier} Training Dummy`;
        if (now >= nextPlayerAttackAt) {
          const result = resolveAttack(player, dummy);
          if (result.hit) dummyHp = Math.max(0, dummyHp - result.damage);
          log.push(buildAttackLine(playerName, dummyName, result, dummyHp, prev.dummyMaxHp));
          nextPlayerAttackAt = now + attackCooldownMs(player.agility);
          sound.current?.play("impact");
        }
        if (dummyHp > 0 && now >= nextDummyAttackAt) {
          const result = resolveAttack(dummy, player);
          if (result.hit) playerHp = Math.max(0, playerHp - result.damage);
          log.push(buildAttackLine(dummyName, playerName, result, playerHp, prev.playerMaxHp));
          nextDummyAttackAt = now + attackCooldownMs(dummy.agility);
        }
        let outcome: RingBattle["outcome"] = "fighting";
        if (dummyHp <= 0) { outcome = "win"; log.push({ text: `${dummyName} topples — you win the bout!` }); sound.current?.play("reveal-legendary"); }
        else if (playerHp <= 0) { outcome = "lose"; log.push({ text: `${playerName} is knocked back — better luck next spar.` }); sound.current?.play("impact"); }
        return { ...prev, playerHp, dummyHp, log: log.slice(-30), nextPlayerAttackAt, nextDummyAttackAt, outcome };
      });
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringBattle?.outcome]);

  // Only "M" is safe as a global hotkey: WASD/arrows drive world movement,
  // and "E" is the world's own interact key (handled inside GymWorld).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (paused || menu || burnFx || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "m") toggleMuted();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, menu, muted, burnFx]);

  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    sound.current?.setMuted(next);
    if (!next) void sound.current?.unlock();
  }
  function navigate(next: Menu) { if (!paused && !burnFx) { setMenu(next); setMessage(""); } }

  function onStationInteract(id: string) {
    if (paused || training || burnFx) return;
    if (id === "ring") { void sound.current?.unlock(); sound.current?.play("select"); setRingBattle(null); setMenu("ring"); return; }
    void sound.current?.unlock();
    sound.current?.play("select");
    setActiveStat(id as StatKey);
    setPickedCandidates(new Set());
    setMenu("sacrifice");
  }

  /** Starts the actual bout against the dummy currently picked in ringDummyTier —
   *  only called from the "Start Training" / "Spar again" buttons, never on arrival. */
  function startRingBattle() {
    if (paused || training || burnFx) return;
    void sound.current?.unlock();
    const dummyCap = TIER_MAX_LEVEL[ringDummyTier];
    const dummyLevels: Stats = { hp: dummyCap, str: dummyCap, agi: dummyCap, def: dummyCap };
    const maxHp = maxHpFor(levels.hp), dummyMaxHp = maxHpFor(dummyLevels.hp), now = Date.now();
    const dummyName = `Tier ${ringDummyTier} Training Dummy`;
    setRingBattle({
      dummyTier: ringDummyTier, dummyLevels,
      playerHp: maxHp, playerMaxHp: maxHp, dummyHp: dummyMaxHp, dummyMaxHp,
      log: [{ text: `${playerName} (${maxHp}/${maxHp}) steps onto the ring against ${dummyName} (${dummyMaxHp}/${dummyMaxHp}).` }],
      nextPlayerAttackAt: now + attackCooldownMs(levels.agi), nextDummyAttackAt: now + attackCooldownMs(dummyLevels.agi),
      outcome: "fighting",
    });
    sound.current?.play("action-start");
  }

  // GymWorld (like the SDK GameWorld) exposes no imperative "walk here" API (it owns movement
  // internally), so clicking a station's custom icon reuses the world's own
  // public tap-to-move affordance: dispatch a synthetic pointerdown at the
  // station's projected screen position on GymWorld's own canvas, exactly
  // as if the player had tapped that spot themselves. A live ref keeps
  // onStationInteract callable from the arrival-polling effect below without
  // that effect re-subscribing on every render.
  const interactRef = useRef(onStationInteract);
  interactRef.current = onStationInteract;

  // Polls GymWorld's canvas for the live walked-to position (it publishes
  // this itself via canvas.dataset.x/y) and fires the interact once the
  // player has arrived within the same `reach` used for the E-key prompt.
  useEffect(() => {
    const id = setInterval(() => {
      const key = walkTarget.current;
      if (!key) return;
      const canvas = stage.current?.querySelector("canvas");
      const x = Number(canvas?.dataset.x), y = Number(canvas?.dataset.y);
      if (!canvas || Number.isNaN(x) || Number.isNaN(y)) return;
      const [tx, ty] = stationPosition(key);
      if (Math.hypot(x - tx, y - ty) <= (key === "ring" ? 90 : 70)) { walkTarget.current = null; interactRef.current(key); }
    }, 150);
    return () => clearInterval(id);
  }, []);

  function walkToStation(key: StationId) {
    if (paused || training || menu || burnFx) return;
    const canvas = stage.current?.querySelector("canvas");
    if (!canvas) return;
    const [tx, ty] = stationPosition(key);
    const reach = key === "ring" ? 90 : 70;
    const currentX = Number(canvas.dataset.x), currentY = Number(canvas.dataset.y);
    if (!Number.isNaN(currentX) && !Number.isNaN(currentY) && Math.hypot(currentX - tx, currentY - ty) <= reach) {
      onStationInteract(key);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const [sx, sy] = project(tx, ty);
    const clientX = rect.left + (sx - VIEW.x) * rect.width / VIEW.width;
    const clientY = rect.top + (sy - VIEW.y) * rect.height / VIEW.height;
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, pointerType: "mouse" }));
    walkTarget.current = key;
  }

  function toggleCandidate(id: bigint) {
    setPickedCandidates(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** Burns every checked candidate at once: XP and training time are summed
   *  across the whole selection, so clearing out a pile of weak fodder only
   *  costs one combined wait instead of one trip per Friend. The actual
   *  training doesn't start until the burn effect (BurnEffectsOverlay, see
   *  the burnFx-resolution effect above) finishes playing — this only
   *  snapshots the xp/seconds it will need and kicks the animation off. */
  function confirmBurn() {
    if (!activeStat || training || paused || burnFx || generation === null || pickedCandidates.size === 0) return;
    const selected = pool.filter(item => pickedCandidates.has(item.id) && item.generation >= generation);
    if (selected.length === 0) return;
    void sound.current?.unlock();
    const statKey = activeStat;
    const xp = selected.reduce((sum, c) => sum + xpForGeneration(c.generation), 0);
    const totalSeconds = selected.reduce((sum, c) => sum + secondsForGeneration(c.generation), 0);
    setPool(prev => prev.filter(item => !pickedCandidates.has(item.id)));
    setPickedCandidates(new Set());
    setMenu(null);
    // Gen 1 is the rarest/most valuable generation in this game's fiction (see
    // the balance model comment up top), so the single most valuable Friend in
    // the batch — not the average — sets how big and long-lived the fire gets.
    const rarestGeneration = selected.reduce<number>((min, c) => Math.min(min, c.generation), 6) as BurnGeneration;
    const intensity = (6 - rarestGeneration) / 5;
    const shown = selected.slice(0, MAX_BURN_FX_PORTRAITS);
    setBurnFx({
      statKey,
      candidates: shown.map(c => {
        const cached = spriteCacheRef.current.get(c.id.toString());
        return { id: c.id.toString(), generation: c.generation, points: cached && cached !== "error" ? spritePoints(cached) : null };
      }),
      overflowCount: selected.length - shown.length,
      xp, totalSeconds,
      receipts: selected.map(c => makeReceipt(friendId.toString(), c.id.toString(), c.generation, statKey, Date.now())),
      startedAt: Date.now(),
      durationMs: reducedMotion ? BURN_REDUCED_DURATION_MS
        : BURN_DURATION_MS_MIN + (BURN_DURATION_MS_MAX - BURN_DURATION_MS_MIN) * intensity,
      intensity,
    });
    sound.current?.play("action-start");
  }

  /** Ends the burn sequence now: the resolve effect above sees the shortened
   *  duration and starts training immediately with the same captured XP/time. */
  function skipBurn() {
    setBurnFx(prev => prev ? { ...prev, durationMs: Math.max(0, Date.now() - prev.startedAt) } : prev);
  }

  function upgradeTier() {
    if (paused || nextTier === null || generation === null) return;
    const cost = tierUpgradeCost(generation, nextTier);
    if (rf < cost) return;
    setRf(value => value - cost);
    setTier(value => (value + 1) as Tier);
    sound.current?.play("reward");
    setMessage(`Upgraded to Tier ${tier + 1} — stat cap is now ${TIER_MAX_LEVEL[tier + 1]}.`);
  }


  const worldPaused = Boolean(menu) || paused || Boolean(training) || Boolean(burnFx);
  const trainingStation = training ? STATIONS[training.statKey] : null;
  const [badgeX, badgeY] = trainingStation ? project(...trainingStation.position) : [0, 0];

  return <section className="gym-root" aria-label="Burning Gym">
    <div className="gym-stage" ref={stage} inert={Boolean(menu) || paused || Boolean(burnFx) || undefined}>
      <GymWorld friendId={friendId} world={world} spawn={spawn} stations={GYM_STATIONS} ring={RING}
        highlight={training ? null : hoveredStation} active={training?.statKey ?? null}
        paused={worldPaused} reducedMotion={reducedMotion} onInteract={onStationInteract} />

      {/* Invisible click targets over each piece of equipment (the art itself is
          drawn on GymWorld's canvas so it depth-sorts with the Friend). Clicking
          walks the Friend over; hovering or focusing lights up that station's mat. */}
      {STAT_KEYS.map(key => {
        const [iconX, iconY] = project(...STATIONS[key].position);
        return <button type="button" key={key} className="gym-station-icon" data-stat={key}
          aria-label={`Walk to the ${STATIONS[key].label} and train ${STAT_LABEL[key]}`} disabled={Boolean(training)}
          style={{ left: `${(iconX - VIEW.x) / 9.6}%`, top: `${(iconY - VIEW.y) / 6.4}%` }}
          onPointerEnter={() => setHoveredStation(key)} onPointerLeave={() => setHoveredStation(null)}
          onFocus={() => setHoveredStation(key)} onBlur={() => setHoveredStation(null)}
          onClick={() => walkToStation(key)}>
          <StationHitArea />
        </button>;
      })}
      {(() => {
        const [ringX, ringY] = project(...RING_STATION.position);
        return <button type="button" className="gym-station-icon gym-ring-icon"
          aria-label={`Walk to the ${RING_STATION.label} and spar with the dummy`} disabled={Boolean(training)}
          style={{ left: `${(ringX - VIEW.x) / 9.6}%`, top: `${(ringY - VIEW.y) / 6.4}%` }}
          onPointerEnter={() => setHoveredStation("ring")} onPointerLeave={() => setHoveredStation(null)}
          onFocus={() => setHoveredStation("ring")} onBlur={() => setHoveredStation(null)}
          onClick={() => walkToStation("ring")}>
          <span className="gym-ring-hit" aria-hidden="true" />
        </button>;
      })()}

      {trainingStation && <div className="gym-training-badge" role="status" aria-live="polite"
        style={{ left: `${(badgeX - VIEW.x) / 9.6}%`, top: `${(badgeY - VIEW.y + trainingStation.labelOffset + 24) / 6.4}%` }}>TRAINING · {formatDuration(remaining)}</div>}

      <button type="button" className="gym-help-button" aria-label="How training works" onClick={() => navigate("help")}>?</button>

      <div className="gym-hud-top">
        <UnitFrame sprites={sprites} friendId={friendId} generation={generation} tier={tier} cap={cap} levels={levels}
          training={training?.statKey ?? null} onOpen={() => navigate("character")} />
        {genError && <button type="button" className="gym-retry-chip" onClick={() => setGenRetry(v => v + 1)}>Retry Friend check</button>}
      </div>

      <p className="gym-message" role="status">
        {message || (training ? `Training at the ${STATIONS[training.statKey].label}…` : "WASD / arrows to walk · tap a station · E to train there.")}
      </p>

      <div className="gym-hud-bottom">
        <span className="gym-rf">{formatGameAmount(rf, RF_DECIMALS)} $RF <small>(demo)</small></span>
        <button type="button" className="gym-primary" onClick={() => navigate("modes")} disabled={paused || Boolean(burnFx)}>GAME MODES</button>
        <button type="button" onClick={() => navigate("settings")}>Settings <kbd>M</kbd></button>
      </div>

    </div>

    {/* Outside the (inert while burning) stage, so a click can skip it. */}
    {burnFx && <BurnEffectsOverlay fx={burnFx} reducedMotion={reducedMotion}
      onCue={cue => sound.current?.play(cue)} onSkip={skipBurn} />}

    {menu === "sacrifice" && activeStat && (() => {
      const selectedCandidates = pool.filter(item => pickedCandidates.has(item.id));
      const projected = selectedCandidates.length > 0 ? (() => {
        const totalXp = selectedCandidates.reduce((sum, c) => sum + xpForGeneration(c.generation), 0);
        const totalSeconds = selectedCandidates.reduce((sum, c) => sum + secondsForGeneration(c.generation), 0);
        const newXp = statXp[activeStat] + totalXp;
        const rawLevel = levelForXp(newXp, xpScale);
        return { totalXp, totalSeconds, rawLevel, cappedLevel: Math.max(1, Math.min(cap, rawLevel)) };
      })() : null;
      return <GameMenu title={STATIONS[activeStat].label} onClose={() => navigate(null)}
        footer={<button type="button" className="gym-primary" disabled={pickedCandidates.size === 0} onClick={confirmBurn}>
          {pickedCandidates.size > 1 ? `Confirm Sacrifice (${pickedCandidates.size})` : "Confirm Sacrifice"}
        </button>}>
        <p>Check off any number of lesser Friends here to train <strong>{STAT_LABEL[activeStat]}</strong> — their XP and training time are combined into one wait. Stats don't rise instantly — your Friend must train it off.</p>
        {projected && (
          <p className="gym-burn-summary">Selected: {selectedCandidates.length} Friend{selectedCandidates.length > 1 ? "s" : ""} · +{projected.totalXp.toLocaleString("en-US")} XP total · {formatDuration(projected.totalSeconds)} training</p>
        )}
        <TierProgressBar tier={tier} statKey={activeStat} currentLevel={levels[activeStat]} projectedLevel={projected?.rawLevel} />
        {projected && projected.rawLevel > cap ? (
          <p className="gym-cap-warning" role="alert">⚠ This will exceed your Tier {tier} cap ({cap}): {STAT_LABEL[activeStat]} will land at {projected.cappedLevel} / {cap}.</p>
        ) : levels[activeStat] >= cap && (
          <p>This stat is already at your Tier {tier} cap ({cap}) — burning still banks XP toward the next Tier upgrade.</p>
        )}
        {generation === null ? <p>Verifying your Friend's generation…</p> : pool.length === 0 ? <p>No Friends left to sacrifice.</p> : <div className="gym-pool" role="group" aria-label="Choose Friends to sacrifice">
          {pool.map(candidate => {
            const eligible = candidate.generation >= generation;
            const xp = xpForGeneration(candidate.generation), seconds = secondsForGeneration(candidate.generation);
            return <label key={candidate.id.toString()} className="gym-pool-item" data-selected={pickedCandidates.has(candidate.id)} data-gen={candidate.generation} data-ineligible={!eligible || undefined}>
              <input type="checkbox" checked={pickedCandidates.has(candidate.id)} disabled={!eligible} onChange={() => toggleCandidate(candidate.id)} />
              <CandidatePortrait id={candidate.id.toString()} generation={candidate.generation} spriteReader={spriteReader} cache={spriteCacheRef} />
              <span><strong>Friend #{candidate.id.toString()}</strong>
                <small>Gen {candidate.generation} · +{xp.toLocaleString("en-US")} XP · {formatDuration(seconds)} training</small>
                {!eligible && <small>Too strong for a Gen {generation} Friend to eat — food chain</small>}
              </span>
            </label>;
          })}
        </div>}
      </GameMenu>;
    })()}

    {menu === "modes" && <GameMenu title="Game Modes" onClose={() => navigate(null)}
      footer={<button type="button" onClick={() => navigate(null)}>Back to the Gym</button>}>
      <PreviewNote />
      <div className="gym-modes">
        {GAME_MODES.map(mode => <article key={mode.id} className="gym-mode" data-mode={mode.id}>
          <div className="gym-mode-art"><GameModeArt mode={mode.id} /><span className="gym-mode-soon">COMING SOON</span></div>
          <h4>{mode.title}</h4>
          <p>{mode.text}</p>
          <small>Uses: {mode.uses}</small>
        </article>)}
      </div>
    </GameMenu>}

    {menu === "ring" && !ringBattle && <GameMenu title="Training Ring" onClose={() => navigate(null)}
      footer={<button type="button" className="gym-primary" onClick={startRingBattle}>Start Training</button>}>
      <p>A free practice bout, using the Combat Engine the future game modes will use: <strong>Strength</strong> sets your Max Hit, <strong>HP</strong> sets your health pool, <strong>Agility</strong> decides who lands hits (and how often), and <strong>Defence</strong> cuts down what gets through — the same rules for both sides. No $RF or XP on the line — just a feel for your current build.</p>
      <p>Pick the dummy's weight class — every dummy is maxed out in all four stats for its Tier, the same as a fully-trained Friend of that Tier:</p>
      <div className="gym-ring-tier-picker" role="radiogroup" aria-label="Dummy weight class">
        {TIER_MAX_LEVEL.map((capValue, t) => (
          <label key={t} className="gym-ring-tier-option" data-selected={ringDummyTier === t}>
            <input type="radio" name="ring-dummy-tier" checked={ringDummyTier === t} onChange={() => setRingDummyTier(t as Tier)} />
            <span><strong>Tier {t}</strong><small>HP {capValue} · STR {capValue} · AGI {capValue} · DEF {capValue}</small></span>
          </label>
        ))}
      </div>
    </GameMenu>}

    {menu === "ring" && ringBattle && <GameMenu title="Training Ring" onClose={() => { setRingBattle(null); navigate(null); }}
      footer={<>
        {ringBattle.outcome !== "fighting" && <button type="button" className="gym-primary" onClick={startRingBattle}>Spar again</button>}
        <button type="button" onClick={() => setRingBattle(null)}>{ringBattle.outcome === "fighting" ? "Retreat" : "Choose a different dummy"}</button>
      </>}>
      <div className="gym-ring-bars">
        <div className="gym-ring-bar" data-side="player">
          <div className="gym-ring-bar-head"><span>Friend #{friendId.toString()}</span><span>{ringBattle.playerHp} / {ringBattle.playerMaxHp}</span></div>
          <div className="gym-stat-track"><div className="gym-stat-fill" style={{ width: `${Math.round(ringBattle.playerHp / ringBattle.playerMaxHp * 100)}%` }} /></div>
        </div>
        <div className="gym-ring-bar" data-side="dummy">
          <div className="gym-ring-bar-head"><span>Tier {ringBattle.dummyTier} Training Dummy</span><span>{ringBattle.dummyHp} / {ringBattle.dummyMaxHp}</span></div>
          <div className="gym-stat-track"><div className="gym-stat-fill" style={{ width: `${Math.round(ringBattle.dummyHp / ringBattle.dummyMaxHp * 100)}%` }} /></div>
        </div>
      </div>
      <div className="gym-log-box"><CombatLogList lines={ringBattle.log} /></div>
      {ringBattle.outcome !== "fighting" && (
        <p className={ringBattle.outcome === "win" ? "gym-win" : "gym-loss"}>{ringBattle.outcome === "win" ? "VICTORY — the dummy is down!" : "DEFEAT — the dummy got the better of you this time."}</p>
      )}
    </GameMenu>}

    {menu === "character" && <GameMenu title="Character" onClose={() => navigate(null)}
      footer={<button type="button" onClick={() => navigate("upgrade")}>Manage Tier Upgrade →</button>}>
      <div className="gym-character-header">
        <div className="gym-character-portrait-frame">{sprites ? <SpritePortrait sprites={sprites} className="gym-character-portrait" /> : null}</div>
        <div>
          <h3>Friend #{friendId.toString()}</h3>
          <p><span className="gym-badge">GEN {generation ?? "…"}</span><span className="gym-badge">TIER {tier}</span><span className="gym-badge">CL {combatLevel(levels)}</span> {sprites?.familyName ?? "…"}</p>
          <p>Stat cap {cap} · {formatGameAmount(rf, RF_DECIMALS)} $RF</p>
        </div>
      </div>
      <PreviewNote />
      <table className="gym-sheet">
        <thead><tr><th aria-label="Icon" /><th>Stat</th><th>Now</th><th>Next level</th></tr></thead>
        <tbody>{STAT_KEYS.map(key => {
          const level = levels[key], xp = statXp[key];
          const intoLevel = Math.max(0, xp - cumulativeXpForLevel(level, xpScale));
          const forNext = level < cap ? cumulativeXpForLevel(level + 1, xpScale) - cumulativeXpForLevel(level, xpScale) : 0;
          const bankedBeyondCap = level >= cap ? Math.max(0, xp - cumulativeXpForLevel(cap, xpScale)) : 0;
          const pct = level >= cap ? 100 : forNext > 0 ? Math.min(100, Math.round((intoLevel / forNext) * 100)) : 0;
          const gain = nextStatGain(key, level, cap);
          const capNote = tier < 4 ? `Tier ${tier} cap reached — Tier ${tier + 1} unlocks Lv ${TIER_MAX_LEVEL[tier + 1]}` : "Fully maxed";
          return <tr key={key} data-stat={key}>
            <td><StatIcon statKey={key} size={16} /></td>
            <td><strong>{STAT_LABEL[key]}</strong><small>Lv {level} / {cap}</small></td>
            <td className="gym-sheet-now">{statReadout(key, level).short}</td>
            <td>
              <span className={`gym-sheet-next${gain ? "" : " gym-sheet-capped"}`}>{gain ?? capNote}</span>
              <span className="gym-stat-track gym-sheet-track"><span className="gym-stat-fill" style={{ width: `${pct}%` }} /></span>
              <small>{level < cap ? (forNext > 0 ? `${intoLevel.toLocaleString("en-US")} / ${forNext.toLocaleString("en-US")} XP` : "Any XP levels up")
                : bankedBeyondCap > 0 ? `${bankedBeyondCap.toLocaleString("en-US")} XP banked for Tier ${tier + 1}` : ""}</small>
            </td>
          </tr>;
        })}</tbody>
      </table>

      {/* Proof of burn: the sheet above is exactly the sum of these receipts. */}
      <section className="gym-proof">
        <p className="gym-proof-lead">Your stats are not stored: they are the sum of these burn receipts. Any game can read the same receipts and get the same sheet. On a sale or transfer, the receipts (and Tier) reset.</p>
        {(() => {
          const counted = receipts.filter(receipt => receipt.trainedAt !== undefined);
          if (!counted.length) return <p className="gym-proof-empty">No burns yet. Sacrifice a Friend at any machine to write your first receipt.</p>;
          const totalXp = counted.reduce((sum, receipt) => sum + receipt.xp, 0);
          const byGeneration = ([1, 2, 3, 4, 5, 6] as const)
            .map(g => [g, counted.filter(receipt => receipt.burnedGeneration === g).length] as const).filter(([, n]) => n > 0);
          const latest = [...counted].reverse();
          return <>
            <ProofOfBurnCard friendId={friendId.toString()} family={sprites?.familyName} generation={generation} tier={tier}
              burned={counted.length} xp={totalXp} combatLevel={combatLevel(levels)} byGeneration={byGeneration}
              latest={latest.slice(0, 6).map(receipt => {
                const cached = spriteCacheRef.current.get(receipt.burned);
                return { id: receipt.burned, generation: receipt.burnedGeneration, points: cached && cached !== "error" ? spritePoints(cached) : null };
              })} />
            <details className="gym-proof-receipts">
              <summary>Receipts ({counted.length})</summary>
              <ol className="gym-proof-log">
                {latest.slice(0, 50).map((receipt, index) => <li key={`${receipt.burned}-${receipt.burnedAt}-${index}`} data-stat={receipt.stat}>
                  <StatIcon statKey={receipt.stat} size={12} />
                  <span>#{receipt.burned} · Gen {receipt.burnedGeneration} → {STAT_LABEL[receipt.stat]} <strong>+{receipt.xp.toLocaleString("en-US")} XP</strong></span>
                  <time>{new Date(receipt.burnedAt).toLocaleTimeString("en-GB")}</time>
                </li>)}
              </ol>
              {counted.length > 50 && <p className="gym-proof-empty">Showing the latest 50 of {counted.length} receipts; the JSON has all of them.</p>}
            </details>
          </>;
        })()}
        <button type="button" className="gym-proof-toggle" aria-expanded={showSheetJson} onClick={() => { setShowSheetJson(value => !value); setCopyStatus(""); }}>
          {showSheetJson ? "Hide" : "View"} character sheet JSON
        </button>
        {showSheetJson && generation !== null && (() => {
          const json = JSON.stringify(buildCharacterSheet({ friendId: friendId.toString(), generation, family: sprites?.familyName, tier, receipts }), null, 2);
          return <div className="gym-proof-json">
            <textarea readOnly value={json} aria-label="Character sheet JSON" rows={10}
              onFocus={event => event.currentTarget.select()} />
            <button type="button" onClick={event => {
              const area = event.currentTarget.previousElementSibling;
              if (area instanceof HTMLTextAreaElement) { area.focus(); area.select(); }
              navigator.clipboard?.writeText(json).then(() => setCopyStatus("Copied."), () => setCopyStatus("Selected: press Ctrl+C / Cmd+C to copy."));
              if (!navigator.clipboard) setCopyStatus("Selected: press Ctrl+C / Cmd+C to copy.");
            }}>Copy JSON</button>
            {copyStatus && <span className="gym-proof-copy">{copyStatus}</span>}
            <p className="gym-proof-empty">Format: <code>proof-of-burn</code> v1 (see PROOF_OF_BURN.md in the repository). Simulated preview data.</p>
          </div>;
        })()}
      </section>
    </GameMenu>}

    {menu === "upgrade" && <GameMenu title="Tier Upgrade" onClose={() => navigate(null)}
      footer={generation !== null && nextTier !== null ? (
        <button type="button" className="gym-primary" disabled={rf < tierUpgradeCost(generation, nextTier)} onClick={upgradeTier}>Upgrade to Tier {tier + 1}</button>
      ) : undefined}>
      {generation === null ? <p>Verifying your Friend's generation…</p> : <>
        <p>Tier is a paid, in-generation upgrade — official Rare Friends pricing, so it costs more for rarer generations. Current: <strong>Gen {generation} · Tier {tier} · cap {cap}</strong> · Balance: <strong>{formatGameAmount(rf, RF_DECIMALS)} $RF</strong>.</p>
        <PreviewNote />
        {/* Visual explainer: every Tier opens the next 20 levels for all four stats. */}
        <div className="gym-tier-explainer">
          <p className="gym-tier-explainer-lead"><strong>Each Tier unlocks 20 more levels</strong> for all four stats; each upgrade costs the $RF shown on its Tier. XP earned above your cap is not lost: it is banked and counts as soon as the next Tier opens.</p>
          <div className="gym-tier-legend">{TIER_MAX_LEVEL.map((capValue, index) => {
            const state = index <= tier ? "open" : index === tier + 1 ? "next" : "locked";
            return <div key={index} className="gym-tier-legend-cell" data-state={state}>
              <strong>Tier {index}</strong>
              <small>Lv {index * 20 + 1}–{capValue}</small>
              <span>{state === "open" ? "✓ Unlocked" : `${state === "next" ? "Next ·" : "🔒"} ${formatGameAmount(tierUpgradeCost(generation, (index - 1) as 0 | 1 | 2 | 3), RF_DECIMALS)} $RF`}</span>
            </div>;
          })}</div>
          {STAT_KEYS.map(key => {
            const banked = Math.max(levels[key], levelForXp(statXp[key], xpScale));
            return <div className="gym-tier-stat-row" key={key}>
              <span className="gym-tier-stat-label"><StatIcon statKey={key} />{STAT_LABEL[key]}<small>Lv {levels[key]}</small></span>
              <TierProgressBar tier={tier} statKey={key} currentLevel={levels[key]} projectedLevel={banked} />
              {banked > levels[key] && <small className="gym-tier-banked">Banked XP already reaches Lv {banked} once unlocked</small>}
            </div>;
          })}
          <p className="gym-tier-key"><span className="gym-tier-key-fill" /> current level <span className="gym-tier-key-banked" /> banked XP <span>🔒 locked Tier</span></p>
        </div>
        {nextTier !== null ? <>
          <p>Next: Tier {tier + 1} (cap {TIER_MAX_LEVEL[tier + 1]}) costs <strong>{formatGameAmount(tierUpgradeCost(generation, nextTier), RF_DECIMALS)} $RF</strong>.</p>
          {rf < tierUpgradeCost(generation, nextTier) && <p>Not enough demo $RF left for this upgrade.</p>}
        </> : <p>Already at the maximum Tier.</p>}
      </>}
    </GameMenu>}

    {menu === "settings" && <GameMenu title="Settings" onClose={() => navigate(null)}>
      <button type="button" aria-pressed={!muted} onClick={toggleMuted}>{muted ? "Sound off" : "Sound on"}</button>
      <label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
      <p>All XP, training, Tier upgrades and $RF in this preview are simulated locally for the session. Your Friend's portrait and generation are read live from the Generations contract.</p>
    </GameMenu>}

    {menu === "help" && <GameMenu title="How Training Works" onClose={() => navigate(null)}>
      <PreviewNote />
      <p>Two separate things determine what your Friend can do: <strong>Tier</strong> (paid with $RF, sets stat caps) and <strong>Generation</strong> (fixed on chain, sets both the "food chain" and how expensive everything is). Yours is <strong>Generation {generation ?? "…"}</strong>.</p>

      <h3>Tier &amp; stat caps</h3>
      <p>Tier upgrade prices follow the real Rare Friends protocol pricing (rarefriends.com/docs/generations): each generation step is 10x the next, and each of the 4 upgrade steps within a generation is 1.5x the last.</p>
      <table className="gym-help-table">
        <thead><tr><th>Gen</th><th>0→1</th><th>1→2</th><th>2→3</th><th>3→4</th></tr></thead>
        <tbody>{([1, 2, 3, 4, 5, 6] as const).map(g => <tr key={g} className={g === generation ? "gym-row-current" : undefined}>
          <td>{g}{g === generation ? " (you)" : ""}</td>
          {[0, 1, 2, 3].map(step => <td key={step}>{formatGameAmount(tierUpgradeCost(g, step as 0 | 1 | 2 | 3), RF_DECIMALS)}</td>)}
        </tr>)}</tbody>
      </table>
      <p>No stat can train past its current Tier's cap, no matter how much XP you feed it — but that XP isn't wasted, it's banked until you upgrade. Open your portrait (top left) → Manage Tier Upgrade to buy the next Tier.</p>

      <h3>Generation &amp; the food chain</h3>
      <p>Your Friend can only burn candidates of its own generation or weaker (a higher generation number = weaker / more common).</p>
      <table className="gym-help-table">
        <thead><tr><th>Your generation</th><th>Can burn</th></tr></thead>
        <tbody>
          {([1, 2, 3, 4, 5, 6] as const).map(g => <tr key={g} className={g === generation ? "gym-row-current" : undefined}>
            <td>Gen {g}{g === generation ? " (you)" : ""}</td>
            <td>{Array.from({ length: 7 - g }, (_, i) => `Gen ${g + i}`).join(", ")}</td>
          </tr>)}
        </tbody>
      </table>

      <h3>The Sacrifice</h3>
      <p>Walk to a station (Barbell Rack = Strength, Sprint Track = Agility, Recovery Bike = HP, Boxing Reflex Trainer = Defence) and press <kbd>E</kbd> — that walk-over is how you choose which stat trains. Burning a candidate grants XP matching its Hardwire value (10x apart per generation, same as the docs' Hardwire table), and takes time to train off:</p>
      <table className="gym-help-table">
        <thead><tr><th>Burned Friend</th><th>XP gained</th><th>Training time</th></tr></thead>
        <tbody>
          {([1, 2, 3, 4, 5, 6] as const).map(g => <tr key={g}><td>Generation {g}</td><td>+{xpForGeneration(g).toLocaleString("en-US")} XP</td><td>{formatDuration(secondsForGeneration(g))}</td></tr>)}
        </tbody>
      </table>

      <h3>XP per level (scales with your generation)</h3>
      <p>One rule drives leveling: burning a Friend of <strong>your own generation</strong> grants exactly enough XP to fully max a stat, from its baseline level 1 up to 100, in one shot (once Tier 4 is unlocked) — no mountain of same-tier burns required. The curve isn't linear though: early levels are cheap, and the final stretch toward 100 is what actually costs close to a full same-generation meal. Weaker fodder still buys real progress, just proportionally less:</p>
      <table className="gym-help-table">
        <thead><tr><th>Level</th><th>% of a same-generation burn</th><th>Your XP needed (Gen {generation ?? "…"})</th></tr></thead>
        <tbody>
          {[10, 20, 40, 50, 60, 80, 90, 100].map(level => <tr key={level}><td>{level}</td><td>{Math.round((level / 100) ** 2 * 100)}%</td><td>{cumulativeXpForLevel(level, xpScale).toLocaleString("en-US")}</td></tr>)}
        </tbody>
      </table>
      <p>Example: for your generation, one Generation 6 scrap ({xpForGeneration(6).toLocaleString("en-US")} XP) gets you to level {Math.max(1, levelForXp(xpForGeneration(6), xpScale))}; one Friend of your own generation ({xpScale.toLocaleString("en-US")} XP) maxes you out at level 100.</p>

      <h3>Combat Engine</h3>
      <p>The Training Ring runs this fight simulation live, and the planned game modes will use the same rules. Two stats become three fighting numbers:</p>
      <table className="gym-help-table">
        <thead><tr><th>Stat</th><th>What it does in a fight</th></tr></thead>
        <tbody>
          <tr><td>Strength</td><td>Max Hit = ⌊1 + Strength × 0.5⌋ — every landed blow rolls a random amount up to this.</td></tr>
          <tr><td>HP</td><td>Max HP = 9 + HP — the damage pool you have to lose before going down.</td></tr>
          <tr><td>Agility</td><td>Hit Chance = 50% + 0.5% per point of Agility above your opponent's (clamped 20–90%), and shortens your own attack cooldown (1.5s ÷ (1 + Agility × 0.01)).</td></tr>
          <tr><td>Defence</td><td>Subtracted from every hit landed against you (minimum 1 damage always gets through).</td></tr>
          <tr><td>CL</td><td>Combat Level = the average of your four stat levels, shown on your portrait.</td></tr>
        </tbody>
      </table>
      <p>Each side attacks on its own independent cooldown — whoever's clock is up first swings, rolls to hit, and if it lands, rolls damage up to their Max Hit minus the defender's Defence. A miss shows as <strong>MISS</strong> in the log; nothing else happens that turn.</p>

      <h3>Game modes (coming soon)</h3>
      <p>The Arena and other modes (PvP duels, PvE dungeons, Tier tournaments, boss raids) are planned, not playable in this preview. They will use the stats you train here through the same Combat Engine. The <strong>$RF balance</strong> is a simulated demo balance, set to exactly cover every Tier upgrade for your generation.</p>

      <h3>The Training Ring</h3>
      <p>The square platform in the courtyard is a free, repeatable practice bout against a dummy — no $RF or XP at stake, just a live feel for your current build, fought out with the same Combat Engine over real time instead of instantly. Walking onto it opens a picker for the dummy's weight class first; the fight itself only starts once you press "Start Training". Every dummy preset is maxed out in all four stats for its Tier — a Tier 4 dummy hits exactly as hard, fast and tough as a fully-trained Tier 4 Friend would.</p>
    </GameMenu>}
  </section>;
}
