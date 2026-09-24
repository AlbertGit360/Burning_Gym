"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, spriteFrame, type GenerationSprites, type SpriteFacing } from "@rarefriends/friendsdk/sprites";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

// These dimensions belong to this example. The SDK only fixes the viewing window.
const WORLD = { width: 2400, height: 1600 };
const VIEW = { width: 960, height: 640 };
const SPAWN = { x: 400, y: 800 };
const RADIUS = 16, SPEED = 240;
type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };
const ponds: Box[] = [
  { x: 810, y: 330, width: 360, height: 220 },
  { x: 1420, y: 1060, width: 430, height: 210 },
];
const trees: Point[] = [
  { x: 260, y: 510 }, { x: 540, y: 500 }, { x: 690, y: 1050 }, { x: 320, y: 1230 },
  { x: 1310, y: 390 }, { x: 1310, y: 1060 }, { x: 1530, y: 470 }, { x: 1760, y: 520 },
  { x: 2050, y: 1120 }, { x: 2140, y: 450 }, { x: 1100, y: 1330 }, { x: 2140, y: 1330 },
];
const markers = [
  { x: 400, y: 800, name: "Trailhead", note: "The meadow stretches far beyond the first screen. Follow the path east." },
  { x: 1220, y: 800, name: "Meadow crossing", note: "Halfway along the trail. Keep going east to the far field, or wander north and south." },
  { x: 2040, y: 800, name: "Far field", note: "You made it across the meadow. Take the long way home past the ponds and trees." },
] as const;
const obstacles: Box[] = [...ponds, ...trees.map(tree => ({ x: tree.x - 18, y: tree.y - 14, width: 36, height: 28 }))];
const keysForMovement = new Set(["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"]);
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const nearestMarker = (position: Point) => markers.findIndex(marker => distance(position, marker) <= 95);

function walkable(position: Point) {
  return position.x >= RADIUS && position.x <= WORLD.width - RADIUS && position.y >= 80 && position.y <= WORLD.height - RADIUS &&
    !obstacles.some(box => distance(position, {
      x: clamp(position.x, box.x, box.x + box.width), y: clamp(position.y, box.y, box.y + box.height),
    }) < RADIUS);
}

/** Small collision steps prevent tunnelling; blocked diagonals slide along the edge. */
function advance(position: Point, dx: number, dy: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
  for (let step = 0; step < steps; step++) {
    const next = { x: position.x + dx / steps, y: position.y + dy / steps };
    if (walkable(next)) Object.assign(position, next);
    else {
      if (walkable({ x: next.x, y: position.y })) position.x = next.x;
      if (walkable({ x: position.x, y: next.y })) position.y = next.y;
    }
  }
}

function paintGround(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#d6dec1"; ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  ctx.fillStyle = "#c2cfad";
  for (let y = 80; y < WORLD.height; y += 100) for (let x = 90; x < WORLD.width; x += 130) {
    ctx.fillRect(x + (y % 70), y, 5, 11); ctx.fillRect(x + 9 + (y % 70), y - 3, 4, 9);
  }
  ctx.strokeStyle = "#c9bc94"; ctx.lineWidth = 108; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(180, 800); ctx.lineTo(2220, 800); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(1220, 250); ctx.lineTo(1220, 1390); ctx.stroke();
  ctx.strokeStyle = "#e9dbb4"; ctx.lineWidth = 96;
  ctx.beginPath(); ctx.moveTo(180, 800); ctx.lineTo(2220, 800); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(1220, 250); ctx.lineTo(1220, 1390); ctx.stroke();
  for (const pond of ponds) {
    ctx.fillStyle = "#8caa9e"; ctx.fillRect(pond.x - 7, pond.y - 7, pond.width + 14, pond.height + 14);
    ctx.fillStyle = "#91b9ba"; ctx.fillRect(pond.x, pond.y, pond.width, pond.height);
    ctx.fillStyle = "#bad4cb";
    for (let row = 28; row < pond.height; row += 42) for (let col = 24; col < pond.width - 24; col += 86) ctx.fillRect(pond.x + col, pond.y + row, 28, 3);
  }
  ctx.strokeStyle = "#9baa81"; ctx.lineWidth = 8; ctx.strokeRect(4, 4, WORLD.width - 8, WORLD.height - 8);
}

function paintTree(ctx: CanvasRenderingContext2D, tree: Point) {
  ctx.fillStyle = "#aec099"; ctx.beginPath(); ctx.ellipse(tree.x, tree.y + 4, 56, 20, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#766544"; ctx.fillRect(tree.x - 18, tree.y - 60, 36, 74);
  ctx.fillStyle = "#48654f"; ctx.fillRect(tree.x - 57, tree.y - 116, 114, 62);
  ctx.fillRect(tree.x - 39, tree.y - 144, 78, 32);
  ctx.fillStyle = "#678360"; ctx.fillRect(tree.x - 50, tree.y - 113, 96, 24);
  ctx.fillRect(tree.x - 32, tree.y - 137, 64, 24);
}

function paintFriend(ctx: CanvasRenderingContext2D, sprites: GenerationSprites, position: Point, facing: SpriteFacing, walking: boolean, frame: number, side: "left" | "right") {
  const rows = spriteFrame(sprites, facing, walking, frame, side).frame.rows;
  const left = Math.round(position.x) - 40, top = Math.round(position.y) - 75;
  // The unmodified canonical 16×16 mask, white one-pixel halo, at integer 5× scale.
  ctx.save(); ctx.beginPath(); ctx.rect(left, top, 80, 80); ctx.clip();
  ctx.fillStyle = "#fff";
  rows.forEach((row, y) => [...row].forEach((pixel, x) => { if (pixel === "#") ctx.fillRect(left + x * 5 - 5, top + y * 5 - 5, 15, 15); }));
  ctx.fillStyle = "#000";
  rows.forEach((row, y) => [...row].forEach((pixel, x) => { if (pixel === "#") ctx.fillRect(left + x * 5, top + y * 5, 5, 5); }));
  ctx.restore();
}

/** Custom top-down world; the runtime still owns connection, identity and sandboxing. */
export default function ScrollingWorld({ friendId, client, paused }: GameComponentProps) {
  const canvas = useRef<HTMLCanvasElement>(null), position = useRef<Point>({ ...SPAWN });
  const camera = useRef<Point>({ x: 0, y: 0 }), keys = useRef(new Set<string>()), destination = useRef<Point | null>(null);
  const [status, setStatus] = useState("Loading the meadow and your Friend…"), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);
  const [near, setNear] = useState(-1), [visited, setVisited] = useState<number[]>([]);
  const [menu, setMenu] = useState<"settings" | number | null>(null), [reducedMotion, setReducedMotion] = useState(false);
  const live = useRef({ paused, reducedMotion, menu }); live.current = { paused, reducedMotion, menu };
  const stop = () => { keys.current.clear(); destination.current = null; };

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(preference.matches); change(); preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);
  useEffect(() => { if (paused || menu !== null) stop(); }, [paused, menu]);
  useEffect(() => {
    const node = canvas.current, ctx = node?.getContext("2d");
    if (!node || !ctx) { setFailed(true); setStatus("This browser cannot render the meadow."); return; }
    let cancelled = false, frame = 0, previous = 0, lastNear = -1;
    let facing: SpriteFacing = "right", side: "left" | "right" = "right";
    const reached = new Set<number>();
    position.current = { ...SPAWN }; stop(); setMenu(null); setNear(-1); setVisited([]); setFailed(false); setStatus("Loading the meadow and your Friend…");
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", stop);
    // The initial read also supplies the runtime's wallet display and ready state.
    void Promise.all([createFriendReader().read(friendId), client.read()]).then(([sprites, snapshot]) => {
      if (cancelled) return;
      if (snapshot.friendId !== friendId) throw new Error("Game session does not match the selected Friend.");
      setStatus("");
      const render = (now: number) => {
        const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 0; previous = now;
        const point = position.current, before = { ...point };
        if (!live.current.paused && live.current.menu === null && !document.hidden) {
          const pressed = (one: string, two: string) => keys.current.has(one) || keys.current.has(two);
          let dx = Number(pressed("d", "arrowright")) - Number(pressed("a", "arrowleft"));
          let dy = Number(pressed("s", "arrowdown")) - Number(pressed("w", "arrowup"));
          let travel = SPEED * dt;
          if (dx || dy) destination.current = null;
          else if (destination.current) {
            dx = destination.current.x - point.x; dy = destination.current.y - point.y;
            travel = Math.min(travel, Math.hypot(dx, dy));
            if (Math.hypot(dx, dy) < 2) { destination.current = null; dx = 0; dy = 0; }
          }
          if (dx || dy) {
            const length = Math.hypot(dx, dy); advance(point, dx / length * travel, dy / length * travel);
            facing = Math.abs(dx) >= Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "up" : "down";
            if (facing === "left" || facing === "right") side = facing;
            if (destination.current && distance(before, point) < 0.1) destination.current = null;
          }
        }
        // One transform is shared by drawing, pointer conversion and screen overlays.
        camera.current = {
          x: Math.round(clamp(point.x - VIEW.width / 2, 0, WORLD.width - VIEW.width)),
          y: Math.round(clamp(point.y - VIEW.height / 2, 0, WORLD.height - VIEW.height)),
        };
        ctx.clearRect(0, 0, VIEW.width, VIEW.height); ctx.save();
        ctx.translate(-camera.current.x, -camera.current.y); ctx.imageSmoothingEnabled = false;
        paintGround(ctx);
        markers.forEach((marker, index) => {
          ctx.fillStyle = reached.has(index) ? "#45664e" : "#ac8a50"; ctx.fillRect(marker.x - 24, marker.y - 13, 48, 26);
          ctx.fillStyle = "#f7efd9"; ctx.font = "bold 14px monospace"; ctx.textAlign = "center"; ctx.fillText(String(index + 1), marker.x, marker.y + 5);
          ctx.fillStyle = "#344b3a"; ctx.font = "14px monospace"; ctx.fillText(marker.name, marker.x, marker.y + 42);
        });
        if (destination.current) {
          ctx.strokeStyle = "#536a4e"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(destination.current.x, destination.current.y, 10, 0, Math.PI * 2); ctx.stroke();
        }
        const layers = trees.map(tree => ({ depth: tree.y, draw: () => paintTree(ctx, tree) }));
        layers.push({ depth: point.y, draw: () => paintFriend(ctx, sprites, point, facing, distance(before, point) > 0.1, live.current.reducedMotion ? 0 : Math.floor(now / 110) % 8, side) });
        layers.sort((a, b) => a.depth - b.depth).forEach(layer => layer.draw()); ctx.restore();
        const close = nearestMarker(point);
        if (close !== lastNear) { lastNear = close; setNear(close); }
        if (close >= 0 && !reached.has(close)) { reached.add(close); setVisited([...reached]); }
        node.dataset.x = point.x.toFixed(2); node.dataset.y = point.y.toFixed(2);
        node.dataset.cameraX = String(camera.current.x); node.dataset.cameraY = String(camera.current.y);
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
    }).catch(() => { if (!cancelled) { setFailed(true); setStatus("The meadow or your Friend's artwork could not load. Check your connection and retry."); } });
    return () => { cancelled = true; cancelAnimationFrame(frame); stop(); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); };
  }, [friendId, client, revision]);

  const blocked = paused || menu !== null || Boolean(status);
  return <section className="meadow-game" aria-label="Long Meadow scrolling world">
    <div className="meadow-world" inert={paused || menu !== null || undefined}>
      <canvas ref={canvas} width={VIEW.width} height={VIEW.height} data-world-width={WORLD.width} data-world-height={WORLD.height}
        tabIndex={blocked ? -1 : 0} aria-label="Explore the meadow. WASD or arrows to walk. Tap a destination. E reads a nearby trail marker."
        onBlur={stop}
        onKeyDown={event => {
          if (blocked) return;
          const key = event.key.toLowerCase();
          if (keysForMovement.has(key)) { event.preventDefault(); keys.current.add(key); }
          if (key === "e" && !event.repeat) { const marker = nearestMarker(position.current); if (marker >= 0) { event.preventDefault(); stop(); setMenu(marker); } }
        }}
        onKeyUp={event => { if (keysForMovement.has(event.key.toLowerCase())) { event.preventDefault(); keys.current.delete(event.key.toLowerCase()); } }}
        onPointerDown={event => {
          if (blocked) return;
          event.preventDefault(); event.currentTarget.focus(); keys.current.clear();
          const rect = event.currentTarget.getBoundingClientRect();
          destination.current = { x: camera.current.x + (event.clientX - rect.left) * VIEW.width / rect.width,
            y: camera.current.y + (event.clientY - rect.top) * VIEW.height / rect.height };
        }} />
      <div className="meadow-hud">
        <div className="meadow-title"><strong>Long Meadow</strong><span>Follow the trail. Find all three markers.</span></div>
        <span className="meadow-progress" aria-live="polite">{visited.length} / 3 <span>discovered</span></span>
        <button type="button" disabled={Boolean(status)} onClick={() => setMenu("settings")}>Settings</button>
      </div>
      {!status && <div className="meadow-guide">
        <p><span className="meadow-desktop-controls">WASD / arrows · </span>Tap to walk <span aria-hidden="true">→</span></p>
        {near >= 0 && <button type="button" onClick={() => setMenu(near)}>Read {markers[near].name}<span className="meadow-desktop-controls"> · E</span></button>}
      </div>}
    </div>
    {status && <div className="meadow-status" role={failed ? "alert" : "status"}><p>{status}</p>
      {failed && <button type="button" disabled={paused} onClick={() => setRevision(value => value + 1)}>Retry loading</button>}</div>}
    {menu !== null && <GameMenu title={menu === "settings" ? "Meadow settings" : markers[menu].name} onClose={() => setMenu(null)}>
      {menu === "settings" ? <>
        <label><input type="checkbox" checked={reducedMotion} disabled={paused} onChange={event => setReducedMotion(event.target.checked)} /> Reduce motion</label>
        <p>This quiet meadow has no audio. Reduced motion uses still Friend frames and the camera follows without easing or shake.</p>
        <p>Explore with WASD, arrow keys, or tap a destination. Walk around ponds and tree trunks. Progress resets when the game reloads.</p>
        <p>Exploration is free. No RF purchases or rewards are used.</p>
      </> : <><p>{markers[menu].note}</p><p>{visited.length} of 3 trail markers discovered this visit.</p></>}
      <button type="button" disabled={paused} onClick={() => setMenu(null)}>Back to the meadow</button>
    </GameMenu>}
  </section>;
}
