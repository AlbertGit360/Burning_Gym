"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { GameItem } from "./items.js";

export type RewardRevealPhase = "anticipation" | "emergence" | "reveal" | "complete";
export type RewardRevealCompletion = "finished" | "skipped" | "reduced-motion";
export type RewardRevealProps = {
  item: GameItem;
  /** A receipt or reward ID. Changing it starts a new presentation. */
  revealKey: string | number;
  reducedMotion?: boolean;
  onPhase?: (phase: RewardRevealPhase, item: GameItem) => void;
  onComplete?: (item: GameItem, reason: RewardRevealCompletion) => void;
  /** Increment to finish from a control outside the artwork. */
  skipSignal?: number;
  showSkipControl?: boolean;
  skipLabel?: string;
  slots?: { itemArt?: ReactNode; anticipation?: ReactNode; emergence?: ReactNode; backdrop?: ReactNode };
  className?: string;
  style?: CSSProperties & Partial<Record<`--game-${string}`, string | number>>;
};

export const REWARD_REVEAL_TIMING = Object.freeze({ emergence: 720, reveal: 1320, complete: 2400 });

const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (callback: () => void) => {
  const query = window.matchMedia(reducedQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};
const readMotion = () => window.matchMedia(reducedQuery).matches;
const serverMotion = () => false;

function ItemBitmap({ item }: { item: GameItem }) {
  const width = item.art?.rows.length ? Math.max(1, ...item.art.rows.map(row => row.length)) : 16;
  const height = item.art?.rows.length || 16;
  const path = (item.art?.rows ?? []).flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === "#" ? [`M${x} ${y}h1v1h-1z`] : [])).join("");
  return <svg viewBox={`0 0 ${width} ${height}`} fill="currentColor" shapeRendering="crispEdges">{path ? <path d={path} /> : <path d="M8 1 15 8 8 15 1 8Z" />}</svg>;
}

/** Presentation only: this component never selects an item or changes an inventory. */
export function RewardReveal(props: RewardRevealProps) {
  return <RewardRevealSequence key={props.revealKey} {...props} />;
}

function RewardRevealSequence({ item, reducedMotion, onPhase, onComplete, skipSignal = 0, showSkipControl = true, skipLabel = "Reveal reward", slots = {}, className = "", style }: RewardRevealProps) {
  const systemReducedMotion = useSyncExternalStore(subscribeMotion, readMotion, serverMotion);
  const reduceMotion = reducedMotion ?? systemReducedMotion;
  const [phase, setPhase] = useState<RewardRevealPhase>(reduceMotion ? "complete" : "anticipation");
  const callbacks = useRef({ item, onPhase, onComplete });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const completed = useRef(false);
  const lastPhase = useRef<RewardRevealPhase | null>(null);
  const previousSkipSignal = useRef(skipSignal);

  useEffect(() => { callbacks.current = { item, onPhase, onComplete }; }, [item, onPhase, onComplete]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  const announcePhase = useCallback((next: RewardRevealPhase) => {
    if (lastPhase.current === next) return;
    lastPhase.current = next;
    callbacks.current.onPhase?.(next, callbacks.current.item);
  }, []);
  const finish = useCallback((reason: RewardRevealCompletion) => {
    if (completed.current) return;
    completed.current = true;
    clearTimers();
    setPhase("complete");
    announcePhase("complete");
    callbacks.current.onComplete?.(callbacks.current.item, reason);
  }, [announcePhase, clearTimers]);

  useEffect(() => {
    if (completed.current) return;
    if (reduceMotion) {
      // A queued callback also cancels cleanly during Strict Mode's effect probe.
      timers.current = [setTimeout(() => finish("reduced-motion"), 0)];
    } else {
      announcePhase("anticipation");
      const advance = (next: RewardRevealPhase) => {
        if (completed.current) return;
        setPhase(next);
        announcePhase(next);
      };
      timers.current = [
        setTimeout(() => advance("emergence"), REWARD_REVEAL_TIMING.emergence),
        setTimeout(() => advance("reveal"), REWARD_REVEAL_TIMING.reveal),
        setTimeout(() => finish("finished"), REWARD_REVEAL_TIMING.complete),
      ];
    }
    return clearTimers;
  }, [announcePhase, clearTimers, finish, reduceMotion]);

  useEffect(() => {
    if (previousSkipSignal.current === skipSignal) return;
    previousSkipSignal.current = skipSignal;
    finish("skipped");
  }, [finish, skipSignal]);

  const special = ["rare", "epic", "legendary", "mythic"].includes(item.rarity ?? "");
  const revealed = phase === "reveal" || phase === "complete";
  const itemArt = slots.itemArt ?? <ItemBitmap item={item} />;
  const particleCount = item.rarity === "mythic" ? 18 : item.rarity === "legendary" ? 14 : special ? 10 : item.rarity === "uncommon" ? 6 : 4;

  return <div className={`rf-reward-reveal ${className}`.trim()} data-reveal-phase={phase} data-rarity={item.rarity} data-reduced-motion={reduceMotion || undefined} data-skip-control={showSkipControl || undefined} style={style}>
    <div className="rf-reward-scene" aria-hidden="true" inert>
      {slots.backdrop && <div className="rf-reward-backdrop">{slots.backdrop}</div>}
      {phase === "anticipation" && <div className="rf-reward-anticipation">{slots.anticipation ?? <div className="rf-reward-focus"><i /><i /><i /><i /><span /></div>}</div>}
      {phase === "emergence" && <div className="rf-reward-emergence">{slots.emergence ?? <div className="rf-reward-silhouette">{itemArt}</div>}</div>}
      <div className="rf-reward-halo" />
      {revealed && <div className="rf-reward-item">{itemArt}</div>}
      <div className="rf-reward-particles">{Array.from({ length: particleCount }, (_, index) => <i key={index} style={{ "--particle-index": index, "--particle-count": particleCount } as CSSProperties} />)}</div>
    </div>
    <span className="rf-reward-announcement" role="status" aria-live="polite">{revealed ? [item.name, item.rarity].filter(Boolean).join(", ") : phase === "anticipation" ? "Preparing reward" : "Reward appearing"}</span>
    {showSkipControl && <button type="button" className="rf-reward-skip" onClick={() => finish("skipped")} disabled={phase === "complete"} aria-label={phase === "complete" ? "Reward revealed" : skipLabel}>{phase === "complete" ? "Reward revealed" : skipLabel}</button>}
  </div>;
}
