"use client";

import { useEffect, useRef, useState } from "react";
import { loadWorldAssets } from "./assets.js";
import { project, unproject, type WorldConfig, type WorldPoint } from "./friend-world.js";
import { createWorldMovement } from "./movement.js";
import { createFriendReader, spriteFrame } from "./friend-sprites.js";

export type GameWorldInteraction = Readonly<{
  id: string; label: string; position: WorldPoint; reach?: number;
  /** Vertical label offset in the native 960 × 640 viewport; keep nearby touch targets apart. */
  labelOffset?: number;
}>;
export type GameWorldProps = {
  friendId: bigint; world: WorldConfig; spawn: WorldPoint; interactions: readonly GameWorldInteraction[];
  paused?: boolean; reducedMotion?: boolean; onInteract: (id: string) => void;
};
const VIEW = { x: 320, y: 330, width: 960, height: 640 };

/** A game viewport, with canonical pixels, terrain, collision and input; adds no frame or identity flow. */
export function GameWorld({ friendId, world, spawn, interactions, paused = false, reducedMotion = false, onInteract }: GameWorldProps) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const mover = useRef<ReturnType<typeof createWorldMovement> | null>(null);
  const live = useRef({ paused, reducedMotion, interactions, onInteract });
  live.current = { paused, reducedMotion, interactions, onInteract };
  const [near, setNear] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Loading world and Friend artwork…"), [failed, setFailed] = useState(false);
  const [size, setSize] = useState({ width: 960, height: 640 });
  const nearest = (point: WorldPoint) => live.current.interactions.filter(item =>
    Math.hypot(point[0] - item.position[0], point[1] - item.position[1]) <= (item.reach ?? 72))
    .sort((a, b) => Math.hypot(point[0] - a.position[0], point[1] - a.position[1]) - Math.hypot(point[0] - b.position[0], point[1] - b.position[1]))[0]?.id ?? null;

  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.min(entry.contentRect.width, entry.contentRect.height * 1.5);
      setSize({ width, height: width / 1.5 });
    });
    observer.observe(root.current); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (paused) mover.current?.stop(); }, [paused]);
  useEffect(() => {
    const node = canvas.current, context = node?.getContext("2d");
    if (!node || !context) { setFailed(true); setStatus("This browser cannot render the world."); return; }
    const abort = new AbortController(), movement = createWorldMovement(world, spawn);
    mover.current = movement; setNear(null); setFailed(false); setStatus("Loading world and Friend artwork…");
    let frame = 0, previous = 0, lastNear: string | null = null, side: "left" | "right" = "right";
    const stop = () => movement.stop();
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", stop);
    void Promise.all([loadWorldAssets(world, { signals: false }, abort.signal), createFriendReader().read(friendId)]).then(([assets, sprites]) => {
      if (abort.signal.aborted) return;
      setStatus("");
      const render = (now: number) => {
        const state = movement.update(!live.current.paused && !document.hidden && previous ? now - previous : 0); previous = now;
        context.clearRect(0, 0, VIEW.width, VIEW.height); context.save();
        context.translate(-VIEW.x, -VIEW.y); context.imageSmoothingEnabled = false; context.drawImage(assets.terrain, 0, 0);
        const [x, y] = project(...state.position);
        const layers = assets.objects.map(object => ({ depth: object.depth, draw: () => context.drawImage(object.image, 0, 0) }));
        layers.push({ depth: state.position[0] + state.position[1], draw: () => {
          if (state.facing === "left" || state.facing === "right") side = state.facing;
          const rows = spriteFrame(sprites, state.facing, state.walking, live.current.reducedMotion ? 0 : Math.floor(now / 110) % 8, side).frame.rows;
          const pixels = rows.flatMap((row, py) => [...row].flatMap((pixel, px) => pixel === "#" ? [[px, py]] : []));
          const left = Math.round(x) - 40, top = Math.round(y) - 75;
          context.save(); context.beginPath(); context.rect(left, top, 80, 80); context.clip(); context.fillStyle = "#fff";
          for (const [px, py] of pixels) context.fillRect(left + px * 5 - 5, top + py * 5 - 5, 15, 15);
          context.fillStyle = "#000";
          for (const [px, py] of pixels) context.fillRect(left + px * 5, top + py * 5, 5, 5);
          context.restore();
        } });
        layers.sort((a, b) => a.depth - b.depth).forEach(layer => layer.draw()); context.restore();
        const target = nearest(state.position);
        if (target !== lastNear) { lastNear = target; setNear(target); }
        node.dataset.x = state.position[0].toFixed(2); node.dataset.y = state.position[1].toFixed(2);
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => { if (!abort.signal.aborted) { setFailed(true); setStatus("World or Friend artwork could not load. Check your connection and retry."); } });
    return () => { abort.abort(); cancelAnimationFrame(frame); stop(); mover.current = null; window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); };
  }, [friendId, world, spawn, revision]);

  return <div ref={root} className="rf-world-view">
    <div className="rf-world-surface" style={size}>
      <canvas ref={canvas} width={960} height={640} tabIndex={paused || status ? -1 : 0}
        aria-label="Playable world. Arrow keys or WASD to walk. Tap a destination. Press E near an activity."
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
          mover.current?.moveTo(unproject(VIEW.x + (event.clientX - rect.left) * 960 / rect.width, VIEW.y + (event.clientY - rect.top) * 640 / rect.height));
        }} />
      {!status && interactions.map(item => { const [x, y] = project(...item.position); return <button type="button" className="rf-world-prompt" key={item.id}
        style={{ left: `${(x - VIEW.x) / 9.6}%`, top: `${(y - VIEW.y + (item.labelOffset ?? 34)) / 6.4}%` }} disabled={paused || near !== item.id}
        onClick={() => onInteract(item.id)}>{item.label}<small>{near === item.id ? "E / tap to interact" : "Walk closer"}</small></button>; })}
    </div>
    {status && <div className="rf-world-loading" role={failed ? "alert" : "status"}><p>{status}</p>{failed && <button type="button" onClick={() => setRevision(value => value + 1)}>Retry artwork</button>}</div>}
  </div>;
}
