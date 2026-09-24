"use client";

/* ------------------------------------------------------------------------ *
 * GymWorld — the Burning Gym's own world renderer ("neon basement" look).
 *
 * FriendSDK's WORLD_RULES.md explicitly allows a custom renderer, art style,
 * palette and assets. This component keeps everything that makes the SDK's
 * GameWorld correct — the SDK's world geometry, collision/pathfinding
 * (`createWorldMovement`), projection (`project`/`unproject`), keyboard +
 * touch input, pause handling, reduced motion, loading/error/retry — and
 * only replaces what is drawn:
 *   - walls, floor, station mats, sign and ring mat come from gym-scene.ts;
 *   - station equipment (gym-equipment.ts) is drawn in code in the same
 *     style and depth-sorted with the Friend, so walking behind a machine
 *     hides the Friend; while a stat trains, the Friend uses that machine;
 *   - the Training Ring is a real square on the floor grid, with ropes in
 *     front of / behind the Friend depending on where it stands;
 *   - the selected Friend is drawn exactly like GameWorld draws it: the
 *     canonical 16 × 16 sprite from the SDK sprite reader, black pixels with
 *     a white 1-px halo, integer placement, 5× scale, walking animation.
 *
 * Like GameWorld it publishes the Friend's live world position on
 * `canvas.dataset.x/y` and accepts tap-to-walk pointerdown events, which the
 * game's click-a-station-to-walk-there feature relies on.
 * ------------------------------------------------------------------------ */
import { useEffect, useMemo, useRef, useState } from "react";
import { loadSvg } from "@rarefriends/friendsdk/assets";
import { unproject, type WorldConfig, type WorldPoint } from "@rarefriends/friendsdk/world";
import { createWorldMovement } from "@rarefriends/friendsdk/movement";
import { createFriendReader, spriteFrame } from "@rarefriends/friendsdk/sprites";
import {
  BG, BRAZIER, FIRE, RENDER_SCALE, SIGN, VIEW, buildBackdropSvg, buildDummySvg, buildRingBackSvg, buildRingFrontSvg,
  ringCorners, toView, type RingGeometry,
} from "./gym-scene";
import { drawEquipment, type EquipmentKind, type RiderPose } from "./gym-equipment";

export type GymStation = Readonly<{
  id: string;
  label: string;
  /** Second line shown on the prompt once the Friend is in reach. */
  action: string;
  position: WorldPoint;
  reach: number;
  /** Vertical offset of the prompt from the station's ground point, in view px. */
  labelOffset: number;
  color: string;
  /** World-space mat under the station. */
  zone: readonly WorldPoint[];
  /** Machine drawn at the station; omitted for the ring, which has its own vector art. */
  equipment?: EquipmentKind;
}>;
export type GymWorldProps = {
  friendId: bigint;
  world: WorldConfig;
  spawn: WorldPoint;
  stations: readonly GymStation[];
  ring: RingGeometry;
  /** Station hovered/focused through the game's own hit areas — its mat glows brighter. */
  highlight?: string | null;
  /** Station currently training — its mat pulses (steady with reduced motion). */
  active?: string | null;
  paused?: boolean;
  reducedMotion?: boolean;
  onInteract: (id: string) => void;
};

type Layer = { depth: number; draw: () => void };

export function GymWorld({ friendId, world, spawn, stations, ring, highlight = null, active = null, paused = false, reducedMotion = false, onInteract }: GymWorldProps) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const mover = useRef<ReturnType<typeof createWorldMovement> | null>(null);
  const live = useRef({ paused, reducedMotion, stations, onInteract, highlight, active });
  live.current = { paused, reducedMotion, stations, onInteract, highlight, active };
  const [near, setNear] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Loading the gym and Friend artwork…"), [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ width: 960, height: 640 });

  const scene = useMemo(() => ({
    backdrop: buildBackdropSvg(world.geometry.polygons[0] ?? [], stations.filter(station => station.equipment).map(station => ({ polygon: station.zone, color: station.color })), ring),
    ringBack: buildRingBackSvg(ring), ringFront: buildRingFrontSvg(ring), dummy: buildDummySvg(ring),
  }), [world, stations, ring]);

  const nearest = (point: WorldPoint) => live.current.stations
    .filter(item => Math.hypot(point[0] - item.position[0], point[1] - item.position[1]) <= item.reach)
    .sort((a, b) => Math.hypot(point[0] - a.position[0], point[1] - a.position[1]) - Math.hypot(point[0] - b.position[0], point[1] - b.position[1]))[0]?.id ?? null;

  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.min(entry.contentRect.width, entry.contentRect.height * 1.5);
      setSize({ width, height: width / 1.5 });
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (paused) mover.current?.stop(); }, [paused]);

  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context) { setFailed(true); setStatus("This browser cannot render the gym."); return; }
    const abort = new AbortController(), movement = createWorldMovement(world, spawn);
    mover.current = movement; setNear(null); setFailed(false); setStatus("Loading the gym and Friend artwork…");
    let frame = 0, previous = 0, lastNear: string | null = null, side: "left" | "right" = "right";
    const stop = () => movement.stop();
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", stop);

    const machines = stations.filter((station): station is GymStation & { equipment: EquipmentKind } => Boolean(station.equipment));
    void Promise.all([
      loadSvg(scene.backdrop, abort.signal), loadSvg(scene.ringBack, abort.signal),
      loadSvg(scene.ringFront, abort.signal), loadSvg(scene.dummy, abort.signal),
      createFriendReader().read(friendId),
    ]).then(([backdrop, ringBack, ringFront, dummy, sprites]) => {
      if (abort.signal.aborted) return;
      setStatus("");
      const idleCache = new Map<string, HTMLCanvasElement>();
      const idleMachine = (station: GymStation & { equipment: EquipmentKind }) => {
        let cached = idleCache.get(station.id);
        if (!cached) {
          cached = document.createElement("canvas");
          cached.width = MACHINE_BOX.width * RENDER_SCALE; cached.height = MACHINE_BOX.height * RENDER_SCALE;
          const offscreen = cached.getContext("2d"), [ox, oy] = toView(...station.position);
          if (offscreen) {
            offscreen.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, (MACHINE_BOX.left - ox) * RENDER_SCALE, (MACHINE_BOX.top - oy) * RENDER_SCALE);
            drawEquipment(offscreen, station.equipment, station.position, { active: false, hot: false, now: 0, still: true, color: station.color }, drawFlame, null);
          }
          idleCache.set(station.id, cached);
        }
        return cached;
      };
      const corners = ringCorners(ring);
      const minX = corners.back[0], minY = corners.back[1], maxX = corners.front[0], maxY = corners.front[1];
      const [brazierX, brazierY] = toView(...BRAZIER);
      const signFlames = [toView(SIGN.from - 12, 0, (SIGN.bottom + SIGN.top) / 2 - 16), toView(SIGN.to + 12, 0, (SIGN.bottom + SIGN.top) / 2 - 16)];

      const render = (now: number) => {
        const still = live.current.reducedMotion;
        const state = movement.update(!live.current.paused && !document.hidden && previous ? now - previous : 0); previous = now;
        context.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
        context.fillStyle = BG; context.fillRect(0, 0, VIEW.width, VIEW.height);
        context.imageSmoothingEnabled = true;
        context.drawImage(backdrop, 0, 0, VIEW.width, VIEW.height);

        // Station mats: brighter while hovered, pulsing while that stat trains.
        for (const station of live.current.stations) {
          const hot = station.id === live.current.highlight, training = station.id === live.current.active;
          if (!hot && !training) continue;
          const pulse = training && !still ? 0.55 + 0.45 * Math.sin(now / 260) : 1;
          outline(context, station.zone, station.color, hot ? 1 : 0.8 * pulse, hot ? 16 : 12);
        }
        for (const [x, y] of signFlames) drawFlame(context, x, y, 0.8, now, still);

        const [px, py] = state.position, playerDepth = px + py;
        const insideRing = px >= minX && px <= maxX && py >= minY && py <= maxY;
        const behindRing = !insideRing && ((px < minX && py <= maxY) || (py < minY && px <= maxX));
        const dummyDepth = ring.center[0] + ring.center[1];
        const ringOffset = (order: number) => behindRing ? playerDepth + order : insideRing
          ? (order === 2 ? playerDepth + 0.3 : order === 1 ? (dummyDepth < playerDepth ? playerDepth - 0.2 : playerDepth + 0.2) : playerDepth - 0.3)
          : playerDepth - 0.4 + order * 0.1;
        const full = (image: CanvasImageSource) => () => context.drawImage(image, 0, 0, VIEW.width, VIEW.height);

        const layers: Layer[] = [
          { depth: ringOffset(0), draw: full(ringBack) },
          { depth: ringOffset(1), draw: full(dummy) },
          { depth: ringOffset(2), draw: full(ringFront) },
          { depth: BRAZIER[0] + BRAZIER[1], draw: () => drawBrazier(context, brazierX, brazierY, now, still) },
          ...machines.map(station => ({ depth: station.position[0] + station.position[1], draw: () => {
            const active = station.id === live.current.active, hot = station.id === live.current.highlight;
            if (!active && !hot) {
              // Idle machines never change, so they are drawn once and reused.
              const cached = idleMachine(station), [ox, oy] = toView(...station.position);
              context.drawImage(cached, ox - MACHINE_BOX.left, oy - MACHINE_BOX.top, MACHINE_BOX.width, MACHINE_BOX.height);
              return;
            }
            drawEquipment(context, station.equipment, station.position,
              { active, hot: station.id === live.current.highlight, now, still, color: station.color }, drawFlame,
              active ? (pose: RiderPose) => {
                // The Friend using this machine: same canonical sprite, posed on the equipment.
                const frameIndex = still ? 0 : Math.floor(pose.frameMs / 110) % 8;
                const rows = spriteFrame(sprites, pose.facing, pose.walking && !still, frameIndex, pose.facing === "left" ? "left" : "right").frame.rows;
                const [x, y] = toView(pose.x, pose.y, pose.lift);
                drawFriend(context, rows, Math.round(x + (pose.dx ?? 0)) - 40, Math.round(y + (pose.dy ?? 0)) - 75);
              } : null);
          } })),
          // While a machine is in use the Friend is drawn by that machine (above) instead of where it stands.
          ...(machines.some(station => station.id === live.current.active) ? [] : [{ depth: playerDepth, draw: () => {
            if (state.facing === "left" || state.facing === "right") side = state.facing;
            const rows = spriteFrame(sprites, state.facing, state.walking, still ? 0 : Math.floor(now / 110) % 8, side).frame.rows;
            const [x, y] = toView(px, py);
            drawFriend(context, rows, Math.round(x) - 40, Math.round(y) - 75);
          } }]),
        ];
        layers.sort((a, b) => a.depth - b.depth).forEach(layer => layer.draw());

        const target = nearest(state.position);
        if (target !== lastNear) { lastNear = target; setNear(target); }
        node.dataset.x = state.position[0].toFixed(2); node.dataset.y = state.position[1].toFixed(2);
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => {
      if (!abort.signal.aborted) { setFailed(true); setStatus("The gym or Friend artwork could not load. Check your connection and retry."); }
    });
    return () => {
      abort.abort(); cancelAnimationFrame(frame); stop(); mover.current = null;
      window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop);
    };
    // `stations`, `ring` and `scene` are module-level constants in the game; the
    // live ref above carries the props that change while the world runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friendId, world, spawn, scene, revision]);

  return <div ref={root} className="gym-world-view">
    <div className="gym-world-surface" style={size}>
      <canvas ref={canvas} width={VIEW.width * RENDER_SCALE} height={VIEW.height * RENDER_SCALE} tabIndex={paused || status ? -1 : 0}
        aria-label="Playable gym. Arrow keys or WASD to walk. Tap a destination. Press E near a station."
        onBlur={() => mover.current?.stop()}
        onKeyDown={event => {
          if (paused || status) return;
          if (event.key.toLowerCase() === "e" && !event.repeat && mover.current) {
            const target = nearest(mover.current.state.position);
            if (target) { event.preventDefault(); onInteract(target); }
          }
          if (mover.current?.setKey(event.key, true)) event.preventDefault();
        }}
        onKeyUp={event => { if (mover.current?.setKey(event.key, false)) event.preventDefault(); }}
        onPointerDown={event => {
          if (paused || status) return;
          event.currentTarget.focus(); const rect = event.currentTarget.getBoundingClientRect();
          mover.current?.moveTo(unproject(VIEW.x + (event.clientX - rect.left) * VIEW.width / rect.width, VIEW.y + (event.clientY - rect.top) * VIEW.height / rect.height));
        }} />
      {/* The station being trained shows its TRAINING badge instead of a prompt. */}
      {!status && stations.filter(item => item.id !== active).map(item => {
        const [x, y] = toView(...item.position);
        return <button type="button" className="gym-world-prompt" key={item.id} data-near={near === item.id || undefined}
          style={{ left: `${x / 9.6}%`, top: `${(y + item.labelOffset) / 6.4}%`, ["--gym-prompt-color" as string]: item.color }}
          disabled={paused || near !== item.id} onClick={() => onInteract(item.id)}>
          {item.label}{near === item.id && <small>{item.action}</small>}
        </button>;
      })}
    </div>
    {status && <div className="gym-world-loading" role={failed ? "alert" : "status"}>
      <p>{status}</p>{failed && <button type="button" onClick={() => setRevision(value => value + 1)}>Retry artwork</button>}
    </div>}
  </div>;
}

/** View-space box (relative to a station's ground point) that holds any machine, for the idle cache. */
const MACHINE_BOX = { left: 110, top: 150, width: 220, height: 210 } as const;

/** Canonical Friend pixels, identical to the SDK GameWorld: white 1-px halo, black 5 × 5 pixels, 80 × 80 box. */
function drawFriend(context: CanvasRenderingContext2D, rows: readonly string[], left: number, top: number) {
  const pixels: [number, number][] = [];
  rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "#") pixels.push([px, py]); }));
  context.save();
  context.imageSmoothingEnabled = false;
  context.beginPath(); context.rect(left, top, 80, 80); context.clip();
  context.fillStyle = "#fff";
  for (const [px, py] of pixels) context.fillRect(left + px * 5 - 5, top + py * 5 - 5, 15, 15);
  context.fillStyle = "#000";
  for (const [px, py] of pixels) context.fillRect(left + px * 5, top + py * 5, 5, 5);
  context.restore();
}

function outline(context: CanvasRenderingContext2D, polygon: readonly WorldPoint[], color: string, alpha: number, blur: number) {
  context.save();
  context.globalAlpha = alpha; context.strokeStyle = color; context.lineWidth = 3;
  context.shadowColor = color; context.shadowBlur = blur * RENDER_SCALE;
  context.beginPath();
  polygon.forEach(([x, y], index) => { const [vx, vy] = toView(x, y); if (index) context.lineTo(vx, vy); else context.moveTo(vx, vy); });
  context.closePath(); context.stroke();
  context.globalAlpha = alpha * 0.12; context.fillStyle = color; context.fill();
  context.restore();
}

/** Three-layer flame (same shape as the game's FlameIcon), anchored at its base. Flickers unless `still`. */
export function drawFlame(context: CanvasRenderingContext2D, x: number, y: number, scale: number, now: number, still: boolean) {
  const flicker = still ? 1 : 1 + 0.09 * Math.sin(now / 90) + 0.05 * Math.sin(now / 37);
  context.save();
  const glow = context.createRadialGradient(x, y - 12 * scale, 0, x, y - 12 * scale, 34 * scale);
  glow.addColorStop(0, "rgba(255,106,26,.45)"); glow.addColorStop(1, "rgba(255,106,26,0)");
  context.fillStyle = glow; context.fillRect(x - 40 * scale, y - 52 * scale, 80 * scale, 80 * scale);
  context.translate(x, y); context.scale(scale, scale * flicker); context.translate(0, -10);
  const layer = (top: number, width: number, bottom: number, color: string) => {
    context.beginPath(); context.moveTo(0, top);
    context.quadraticCurveTo(width, -8, 0, bottom); context.quadraticCurveTo(-width, -8, 0, top);
    context.fillStyle = color; context.fill();
  };
  layer(-24, 13, 10, "#c62800"); layer(-19, 9, 6, "#ff5e1a"); layer(-12, 5, 2, "#ffd23f");
  context.restore();
}

/** The fire barrel in the back corner. */
function drawBrazier(context: CanvasRenderingContext2D, x: number, y: number, now: number, still: boolean) {
  context.save();
  context.fillStyle = "rgba(0,0,0,.5)";
  context.beginPath(); context.ellipse(x, y + 2, 20, 7, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#2a2a33"; context.strokeStyle = "#000"; context.lineWidth = 2;
  context.fillRect(x - 15, y - 34, 30, 36); context.strokeRect(x - 15, y - 34, 30, 36);
  context.strokeStyle = "#4a4a58";
  context.beginPath(); context.moveTo(x - 15, y - 24); context.lineTo(x + 15, y - 24); context.moveTo(x - 15, y - 10); context.lineTo(x + 15, y - 10); context.stroke();
  context.fillStyle = FIRE; context.fillRect(x - 13, y - 36, 26, 3);
  context.restore();
  drawFlame(context, x, y - 34, 1.35, now, still);
}
