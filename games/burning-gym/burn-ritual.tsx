"use client";

/* ------------------------------------------------------------------------ *
 * BurnRitual — the full-screen "sacrifice" sequence played after the player
 * confirms which lesser Friends to burn.
 *
 *   1. Summon   — the screen darkens, the chosen Friends rise onto burning
 *                 grates, each labelled with its token number and generation.
 *   2. Ignite   — fire catches at their feet, the sprites heat up and flicker.
 *   3. Burn     — a ragged burn line climbs each sprite from bottom to top:
 *                 pixels glow white-hot at the edge, char, then break off as
 *                 embers and smoke that rise away.
 *   4. Absorb   — the embers stream across the gym into the station the
 *                 player chose, which flashes and shows the XP gained.
 *
 * Longer and bigger for rarer Friends (Gen 1 burns hottest). Click, tap,
 * Space, Enter or Esc skips straight to training. Purely visual: confirmBurn()
 * has already captured the XP/time, and the parent starts training as soon
 * as the sequence finishes or is skipped. Only sacrifice candidates are ever
 * drawn here — the player's own Friend artwork is never altered.
 * ------------------------------------------------------------------------ */
import { useEffect, useRef } from "react";
import type { FriendSoundCue } from "@rarefriends/friendsdk/sounds";
import { drawFlame } from "./gym-world";
import { RENDER_SCALE, VIEW } from "./gym-scene";

export type RitualCandidate = Readonly<{ id: string; generation: number; color: string; points: readonly { x: number; y: number }[] }>;
export type BurnRitualProps = {
  candidates: readonly RitualCandidate[];
  overflowCount: number;
  /** 0 (only Gen 6 burned) … 1 (a Gen 1 was burned). */
  intensity: number;
  durationMs: number;
  /** Station the embers fly into, in view coordinates (960 × 640). */
  target: readonly [number, number];
  statLabel: string;
  statColor: string;
  xp: number;
  onCue?: (cue: FriendSoundCue) => void;
  onSkip: () => void;
};

/** Phase boundaries as fractions of the total duration. */
const SUMMON_END = 0.14, IGNITE_END = 0.28, BURN_END = 0.7, ABSORB_END = 0.93;

type Ember = {
  x: number; y: number; vx: number; vy: number; size: number; born: number; life: number; smoke: boolean;
  fly?: { fromX: number; fromY: number; ctrlX: number; ctrlY: number; start: number; duration: number };
};

/** Free-flight position of an ember `t` seconds after it broke off: rising, drifting, a little flutter. */
function freePosition(ember: Ember, t: number): [number, number] {
  return [ember.x + ember.vx * t + Math.sin((ember.born + t) * 6 + ember.x) * 6, ember.y + ember.vy * t + 20 * t * t];
}
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const ease = (t: number) => t * t * (3 - 2 * t);
function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
function mix(a: readonly number[], b: readonly number[], t: number) {
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t)) as [number, number, number];
}
const CHAR: readonly number[] = [42, 18, 10], WHITE_HOT: readonly number[] = [255, 244, 190], ORANGE: readonly number[] = [255, 138, 40];
/** Ember colour over its life: white-hot → orange → red → dim ember. */
function emberColor(age: number): [number, number, number] {
  if (age < 0.25) return mix(WHITE_HOT, ORANGE, age / 0.25);
  if (age < 0.6) return mix(ORANGE, [230, 50, 20], (age - 0.25) / 0.35);
  return mix([230, 50, 20], [90, 20, 10], (age - 0.6) / 0.4);
}

export function BurnRitual({ candidates, overflowCount, intensity, durationMs, target, statLabel, statColor, xp, onCue, onSkip }: BurnRitualProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ onCue, onSkip });
  live.current = { onCue, onSkip };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === " " || event.key === "Enter") { event.preventDefault(); live.current.onSkip(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const count = candidates.length;
    const S = count <= 2 ? 7 : count <= 3 ? 6 : count <= 4 ? 5 : 4;
    const cell = 16 * S, gap = S * 7;
    const rowWidth = count * cell + (count - 1) * gap;
    const rowLeft = VIEW.width / 2 - rowWidth / 2, rowTop = 230;
    const flameScale = (S / 5) * (0.9 + intensity * 0.6);

    // Per-pixel data: a random "noise" offset gives the burn line a ragged,
    // organic edge instead of a clean horizontal wipe.
    const sprites = candidates.map((candidate, index) => ({
      candidate, left: rowLeft + index * (cell + gap), rgb: hexToRgb(candidate.color),
      stagger: count > 1 ? (index / (count - 1)) * 0.05 : 0,
      pixels: candidate.points.map(point => ({ ...point, noise: Math.random() * 2.2, burned: false })),
    }));
    const embers: Ember[] = [];
    const [targetX, targetY] = target;
    let absorbStarted = false, ignited = false, frame = 0;
    const start = performance.now();

    /** Burn line position (in sprite rows, 18 → -3) for one sprite at time fraction t. */
    const frontAt = (t: number, stagger: number) => {
      const local = clamp((t - IGNITE_END - stagger) / (BURN_END - IGNITE_END - 0.05));
      return 18 - ease(local) * 21;
    };

    const draw = (now: number) => {
      const elapsed = now - start, t = clamp(elapsed / durationMs), seconds = elapsed / 1000;
      context.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
      context.clearRect(0, 0, VIEW.width, VIEW.height);
      const appear = clamp(t / 0.06), fadeOut = 1 - clamp((t - 0.95) / 0.05);
      const shake = t > SUMMON_END && t < BURN_END ? (Math.random() - 0.5) * 2.4 * (0.4 + intensity) * (1 - clamp((t - IGNITE_END) / 0.3)) : 0;

      // Darken the gym and light the altar.
      context.globalAlpha = fadeOut;
      context.fillStyle = `rgba(4,4,10,${0.72 * appear})`;
      context.fillRect(0, 0, VIEW.width, VIEW.height);
      const heat = clamp((t - SUMMON_END) / (IGNITE_END - SUMMON_END)) * (1 - clamp((t - BURN_END) / 0.15));
      if (heat > 0) {
        const glow = context.createRadialGradient(480, rowTop + cell * 0.7, 10, 480, rowTop + cell * 0.7, 260 + rowWidth / 2);
        glow.addColorStop(0, `rgba(255,94,26,${(0.35 + intensity * 0.25) * heat})`); glow.addColorStop(1, "rgba(255,94,26,0)");
        context.fillStyle = glow; context.fillRect(0, 0, VIEW.width, VIEW.height);
      }

      // Title.
      context.textAlign = "center";
      context.globalAlpha = fadeOut * clamp(t / SUMMON_END) * (1 - clamp((t - ABSORB_END) / 0.05));
      context.font = "900 28px 'Courier New', monospace"; context.fillStyle = "#ff8a3d";
      context.shadowColor = "#ff5e1a"; context.shadowBlur = 14 * RENDER_SCALE;
      context.fillText("S A C R I F I C E", 480, 150);
      context.shadowBlur = 0;
      context.font = "700 13px 'Courier New', monospace"; context.fillStyle = "#e6ffcf";
      const total = count + overflowCount;
      context.fillText(`${total} Friend${total > 1 ? "s" : ""} burn to train ${statLabel}`, 480, 176);
      context.globalAlpha = fadeOut;

      if (!ignited && t >= SUMMON_END) { ignited = true; live.current.onCue?.("impact"); }

      // Grates, Friends, flames.
      context.save(); context.translate(shake, 0);
      for (const sprite of sprites) {
        const rise = 1 - ease(clamp(t / SUMMON_END)), top = rowTop + rise * 50;
        const alpha = clamp(t / SUMMON_END * 1.4);
        const front = frontAt(t, sprite.stagger);
        const igniteHeat = clamp((t - SUMMON_END) / (IGNITE_END - SUMMON_END));

        // Burning grate under each Friend.
        const grateY = rowTop + cell + 6;
        context.globalAlpha = fadeOut * alpha;
        context.fillStyle = "#1a1a24"; context.fillRect(sprite.left - 8, grateY, cell + 16, 8);
        context.fillStyle = `rgba(255,${Math.round(90 + 60 * igniteHeat)},30,${0.4 + 0.6 * igniteHeat})`;
        context.fillRect(sprite.left - 8, grateY, cell + 16, 2);

        // Sprite pixels: tint warmer as the fire catches, char near the burn line,
        // glow white-hot right at it, and break off into embers once it passes.
        let remaining = 0;
        for (const pixel of sprite.pixels) {
          const row = pixel.y + pixel.noise * 0.5;
          if (!pixel.burned && front < row) {
            pixel.burned = true;
            const px = sprite.left + pixel.x * S + S / 2, py = top + pixel.y * S + S / 2;
            embers.push({ x: px, y: py, vx: (Math.random() - 0.5) * 50, vy: -(50 + Math.random() * 90) * (1 + intensity * 0.5),
              size: S * (0.6 + Math.random() * 0.5), born: seconds, life: 0.9 + Math.random() * 0.9, smoke: false });
            if (Math.random() < 0.35) embers.push({ x: px, y: py, vx: (Math.random() - 0.5) * 20, vy: -(25 + Math.random() * 30),
              size: S * 1.2, born: seconds, life: 1.4 + Math.random(), smoke: true });
          }
          if (pixel.burned) continue;
          remaining++;
          const distance = row - front; // rows above the burn line
          const edge = clamp(1 - distance / 2.2), char = clamp(1 - distance / 5.5);
          let rgb = mix(sprite.rgb, [255, 170, 110], igniteHeat * 0.35);
          rgb = mix(rgb, CHAR, char * 0.85);
          rgb = mix(rgb, edge > 0.5 ? WHITE_HOT : ORANGE, edge);
          const flicker = igniteHeat > 0 ? 0.85 + Math.random() * 0.15 : 1;
          context.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          context.globalAlpha = fadeOut * alpha * flicker;
          context.fillRect(sprite.left + pixel.x * S, top + pixel.y * S, S, S);
        }

        // Flames riding the burn line (they start at the feet during ignite).
        const alive = remaining > 0 ? 1 : clamp(1 - (t - BURN_END) / 0.06);
        if (igniteHeat > 0 && alive > 0) {
          const flameY = top + clamp(front + 1, -1, 16) * S;
          const grow = ease(igniteHeat) * alive;
          context.globalAlpha = fadeOut;
          for (let k = 0; k < 4; k++) {
            const fx = sprite.left + cell * (0.14 + k * 0.24) + Math.sin(seconds * 3 + k * 2) * S;
            drawFlame(context, fx, flameY + S, flameScale * grow * (0.8 + 0.35 * Math.sin(seconds * 5 + k)), now + k * 97, false);
          }
        }

        // Token label under the grate, fading as the Friend burns away.
        const burnedShare = 1 - remaining / Math.max(1, sprite.pixels.length);
        context.globalAlpha = fadeOut * alpha * (1 - burnedShare * 0.8);
        context.textAlign = "center";
        context.font = "700 12px 'Courier New', monospace"; context.fillStyle = "#e6ffcf";
        context.fillText(`#${sprite.candidate.id}`, sprite.left + cell / 2, grateY + 24);
        context.font = "700 10px 'Courier New', monospace"; context.fillStyle = sprite.candidate.color;
        context.fillText(`GEN ${sprite.candidate.generation}`, sprite.left + cell / 2, grateY + 38);
      }
      if (overflowCount > 0) {
        context.globalAlpha = fadeOut * clamp(t / SUMMON_END) * (1 - clamp((t - BURN_END) / 0.1));
        context.textAlign = "left"; context.font = "900 18px 'Courier New', monospace"; context.fillStyle = "#ff8a3d";
        context.fillText(`+${overflowCount}`, rowLeft + rowWidth + 18, rowTop + cell / 2 + 6);
      }
      context.restore();

      // Absorb: every ember still in the air arcs into the chosen station.
      if (!absorbStarted && t >= BURN_END) {
        absorbStarted = true;
        live.current.onCue?.("action-ready");
        const span = (ABSORB_END - BURN_END) * durationMs / 1000;
        for (const ember of embers) {
          if (ember.smoke || seconds - ember.born > ember.life) continue;
          const delay = Math.random() * span * 0.35;
          const [fromX, fromY] = freePosition(ember, seconds + delay - ember.born);
          ember.fly = { fromX, fromY, ctrlX: (fromX + targetX) / 2 + (Math.random() - 0.5) * 160,
            ctrlY: Math.min(fromY, targetY) - 90 - Math.random() * 80, start: seconds + delay, duration: span * (0.45 + Math.random() * 0.2) };
          ember.life = Math.max(ember.life, seconds - ember.born + delay + ember.fly.duration + 0.05);
        }
      }

      // Embers and smoke.
      for (const ember of embers) {
        const age = seconds - ember.born;
        if (age > ember.life) continue;
        const k = age / ember.life;
        let x: number, y: number;
        if (ember.fly && seconds >= ember.fly.start) {
          const p = ease(clamp((seconds - ember.fly.start) / ember.fly.duration));
          if (p >= 1) continue;
          const a = 1 - p;
          x = a * a * ember.fly.fromX + 2 * a * p * ember.fly.ctrlX + p * p * targetX;
          y = a * a * ember.fly.fromY + 2 * a * p * ember.fly.ctrlY + p * p * targetY;
        } else {
          [x, y] = freePosition(ember, age);
        }
        if (ember.smoke) {
          context.globalCompositeOperation = "source-over";
          context.globalAlpha = fadeOut * 0.28 * (1 - k);
          context.fillStyle = "#5a5560";
          context.beginPath(); context.arc(x, y, ember.size * (0.6 + k * 1.6), 0, Math.PI * 2); context.fill();
        } else {
          const [r, g, b] = ember.fly ? mix(WHITE_HOT, hexToRgb(statColor), 0.65) : emberColor(k);
          context.globalCompositeOperation = "lighter";
          context.globalAlpha = fadeOut * (ember.fly ? 0.95 : 1 - k * 0.8);
          const size = ember.size * (ember.fly ? 0.7 : 1 - k * 0.5);
          context.fillStyle = `rgb(${r},${g},${b})`;
          context.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
      context.globalCompositeOperation = "source-over";

      // The station drinks it in: a flash ring and the XP gained.
      if (t >= ABSORB_END - 0.08) {
        const p = clamp((t - (ABSORB_END - 0.08)) / 0.15);
        context.globalAlpha = fadeOut * (1 - p);
        context.strokeStyle = statColor; context.lineWidth = 4;
        context.shadowColor = statColor; context.shadowBlur = 18 * RENDER_SCALE;
        context.beginPath(); context.ellipse(targetX, targetY, 20 + p * 90, (20 + p * 90) * 0.45, 0, 0, Math.PI * 2); context.stroke();
        context.shadowBlur = 0;
        context.globalAlpha = fadeOut * clamp(p * 3);
        context.textAlign = "center"; context.font = "900 20px 'Courier New', monospace"; context.fillStyle = statColor;
        context.fillText(`+${xp.toLocaleString("en-US")} XP · ${statLabel}`, targetX, targetY - 70 - p * 24);
      }

      // Skip hint.
      context.globalAlpha = fadeOut * clamp(t / SUMMON_END) * 0.7;
      context.textAlign = "center"; context.font = "11px 'Courier New', monospace"; context.fillStyle = "#9a9aa8";
      context.fillText("click or press Space to skip", 480, 548);
      context.globalAlpha = 1;

      if (t < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
    // Runs once per sacrifice: the parent mounts a fresh ritual for each burn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="gym-burn-ritual" width={VIEW.width * RENDER_SCALE} height={VIEW.height * RENDER_SCALE}
    role="img" aria-label="Sacrifice in progress. Click to skip." onPointerDown={() => onSkip()} />;
}
