/* ------------------------------------------------------------------------ *
 * Gym equipment, drawn in code in the same neon-basement style as the room.
 *
 * Every piece is built from real isometric geometry (world x/y plus a
 * vertical "lift" in pixels) through the SDK's own `project()` via toView,
 * so the machines sit on the same floor grid as the walls, mats and ring
 * and share one palette: dark gunmetal bodies, chrome tubes with black
 * outlines, and the station's stat colour as the neon accent.
 *
 * While a station trains, the Friend "uses" it: `drawEquipment` calls the
 * `rider` callback between the machine's back and front parts so the Friend
 * is layered correctly inside it (sitting on the bike, under the bar, on the
 * belt, facing the reflex ball), and each machine animates — the bike's
 * flywheel spins inside a ring of fire, the barbell presses up and down, the
 * treadmill belt scrolls, the reflex ball swings back after every punch.
 * The Friend itself is always the canonical sprite; only its position and
 * sprite frame change.
 * ------------------------------------------------------------------------ */
import type { WorldPoint } from "@rarefriends/friendsdk/world";
import type { SpriteFacing } from "@rarefriends/friendsdk/sprites";
import { toView } from "./gym-scene";

export type EquipmentKind = "bike" | "barbell" | "treadmill" | "reflex";
/** Draw the Friend standing on world point (x, y) raised by `lift` px, with a screen-space nudge. */
export type RiderPose = Readonly<{ x: number; y: number; lift: number; facing: SpriteFacing; walking: boolean; frameMs: number; dx?: number; dy?: number }>;
export type EquipmentState = Readonly<{ active: boolean; hot: boolean; now: number; still: boolean; color: string }>;
type Flame = (context: CanvasRenderingContext2D, x: number, y: number, scale: number, now: number, still: boolean) => void;

type P3 = readonly [number, number, number];
const OUTLINE = "#07070b", METAL = "#34343f", METAL_DARK = "#20202a", CHROME = "#b9b9c8", RUBBER = "#15151c";

/** Machines are modelled at a compact size and scaled up around their station
 *  anchor so they match the Friend sprite's proportions (it stands ~70 px tall). */
const SCALE = 1.35;
let origin: WorldPoint = [0, 0];
const v = ([x, y, lift]: P3) => toView(origin[0] + (x - origin[0]) * SCALE, origin[1] + (y - origin[1]) * SCALE, lift * SCALE);

function tube(context: CanvasRenderingContext2D, a: P3, b: P3, color: string, thickness: number) {
  const [ax, ay] = v(a), [bx, by] = v(b), width = thickness * 1.2;
  context.lineCap = "round";
  context.strokeStyle = OUTLINE; context.lineWidth = width + 3;
  context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.stroke();
  context.strokeStyle = color; context.lineWidth = width;
  context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.stroke();
}
function neon(context: CanvasRenderingContext2D, points: readonly P3[], color: string, width: number, glow: number, close = false) {
  context.save();
  context.strokeStyle = color; context.lineWidth = width; context.lineJoin = "round"; context.lineCap = "round";
  if (glow > 0) { context.shadowColor = color; context.shadowBlur = glow; }
  context.beginPath();
  points.forEach((p, i) => { const [x, y] = v(p); if (i) context.lineTo(x, y); else context.moveTo(x, y); });
  if (close) context.closePath();
  context.stroke();
  context.restore();
}
function face(context: CanvasRenderingContext2D, points: readonly P3[], fill: string) {
  context.beginPath();
  points.forEach((p, i) => { const [x, y] = v(p); if (i) context.lineTo(x, y); else context.moveTo(x, y); });
  context.closePath();
  context.fillStyle = fill; context.fill();
  context.strokeStyle = OUTLINE; context.lineWidth = 1.5; context.lineJoin = "round"; context.stroke();
}
/** Axis-aligned box: draws the three faces visible from this camera (top, +y side, +x side). */
function box(context: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, l0: number, l1: number, top: string, sideY: string, sideX: string) {
  face(context, [[x0, y1, l0], [x1, y1, l0], [x1, y1, l1], [x0, y1, l1]], sideY);
  face(context, [[x1, y0, l0], [x1, y1, l0], [x1, y1, l1], [x1, y0, l1]], sideX);
  face(context, [[x0, y0, l1], [x1, y0, l1], [x1, y1, l1], [x0, y1, l1]], top);
}
/** Points of a circle standing upright in the x–lift plane (a wheel seen side-on along world x). */
function ringXZ(cx: number, cy: number, lift: number, radius: number, steps = 24): P3[] {
  return Array.from({ length: steps }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return [cx + radius * Math.cos(angle), cy, lift + radius * 1.36 * Math.sin(angle)] as P3;
  });
}
/** Points of a circle standing upright in the y–lift plane (a weight plate on a bar running along world y). */
function ringYZ(cx: number, cy: number, lift: number, radius: number, steps = 20): P3[] {
  return Array.from({ length: steps }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return [cx, cy + radius * Math.cos(angle), lift + radius * 1.36 * Math.sin(angle)] as P3;
  });
}
function floorEllipse(context: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: string, lift = 0) {
  const points = Array.from({ length: 24 }, (_, i) => {
    const angle = (i / 24) * Math.PI * 2;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle), lift] as P3;
  });
  context.beginPath();
  points.forEach((p, i) => { const [x, y] = v(p); if (i) context.lineTo(x, y); else context.moveTo(x, y); });
  context.closePath(); context.fillStyle = fill; context.fill();
}
function shadow(context: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) {
  floorEllipse(context, cx, cy, rx, ry, "rgba(0,0,0,.5)");
}

/**
 * Draws one machine at its station anchor. `rider` (when the station is
 * training) is called at the right depth with the pose the Friend should
 * take on this machine; `flame` is the room's shared flame renderer.
 */
export function drawEquipment(context: CanvasRenderingContext2D, kind: EquipmentKind, [ax, ay]: WorldPoint, state: EquipmentState,
  flame: Flame, rider: ((pose: RiderPose) => void) | null) {
  origin = [ax, ay];
  // Rider poses are given in the machine's model space; map them to the world like every other point.
  const place = rider && ((pose: RiderPose) => rider({ ...pose,
    x: ax + (pose.x - ax) * SCALE, y: ay + (pose.y - ay) * SCALE, lift: pose.lift * SCALE }));
  context.save();
  switch (kind) {
    case "bike": drawBike(context, ax, ay, state, flame, place); break;
    case "barbell": drawBarbell(context, ax, ay, state, flame, place); break;
    case "treadmill": drawTreadmill(context, ax, ay, state, flame, place); break;
    case "reflex": drawReflex(context, ax, ay, state, place); break;
  }
  context.restore();
}

/* ---------------- Recovery Bike (HP): flywheel spins inside a ring of fire ---------------- */
function drawBike(context: CanvasRenderingContext2D, ax: number, ay: number, state: EquipmentState, flame: Flame, rider: ((pose: RiderPose) => void) | null) {
  const { active, hot, now, still, color } = state, cy = ay + 14, glow = hot || active ? 12 : 0;
  const spin = active && !still ? now * 0.012 : 0.4;
  shadow(context, ax - 1, cy, 32, 15);
  box(context, ax - 28, ax - 21, cy - 14, cy + 14, 0, 5, METAL, METAL_DARK, METAL_DARK);   // rear foot
  box(context, ax + 18, ax + 25, cy - 14, cy + 14, 0, 5, METAL, METAL_DARK, METAL_DARK);   // front foot
  tube(context, [ax - 24, cy, 5], [ax - 16, cy, 50], CHROME, 4);          // seat post
  tube(context, [ax - 16, cy, 40], [ax, cy, 18], METAL, 5);               // down tube
  tube(context, [ax - 16, cy, 46], [ax + 15, cy, 56], METAL, 4);          // top tube
  tube(context, [ax + 21, cy, 5], [ax + 14, cy, 68], METAL, 5);           // front column
  box(context, ax - 22, ax - 10, cy - 5, cy + 5, 49, 54, "#1b1b24", "#101016", "#101016"); // saddle
  neon(context, [[ax - 16, cy, 40], [ax, cy, 18]], color, 1.5, glow);

  if (rider) {
    const pedal = Math.floor(now / 70) % 8;
    rider({ x: ax - 15, y: cy, lift: 44, facing: "right", walking: true, frameMs: pedal * 110, dy: still ? 0 : Math.sin(now / 90) * 1.2 });
  }

  // Crank and pedals.
  neon(context, ringXZ(ax, cy, 18, 5, 12), "#50505e", 2, 0, true);
  for (const offset of [0, Math.PI]) {
    const angle = spin * 1.4 + offset;
    tube(context, [ax, cy, 18], [ax + 6 * Math.cos(angle), cy + (offset ? 5 : -5), 18 + 8 * Math.sin(angle)], CHROME, 2);
  }
  // Flywheel: dark disk, rotating spokes, neon rim — a ring of fire while training.
  const wx = ax + 16, wl = 27, radius = 15;
  const rim = ringXZ(wx, cy, wl, radius, 28);
  face(context, rim, RUBBER);
  for (let k = 0; k < 6; k++) {
    const angle = spin + (k * Math.PI) / 3;
    tube(context, [wx, cy, wl], [wx + radius * 0.85 * Math.cos(angle), cy, wl + radius * 1.16 * Math.sin(angle)], "#55556a", 1.5);
  }
  neon(context, rim, active ? "#ff8a3d" : color, 2.5, active ? 16 : glow, true);
  if (active) {
    for (let k = 0; k < 8; k++) {
      const angle = spin * 0.8 + (k / 8) * Math.PI * 2;
      const [fx, fy] = v([wx + radius * Math.cos(angle), cy, wl + radius * 1.36 * Math.sin(angle)]);
      flame(context, fx, fy + 4, 0.36 + 0.08 * Math.sin(now / 80 + k), now + k * 131, still);
    }
  }
  box(context, wx - 2, wx + 2, cy - 2, cy + 2, wl - 2, wl + 2, CHROME, "#8a8a9e", "#8a8a9e");
  // Handlebars and console.
  tube(context, [ax + 14, cy - 11, 69], [ax + 14, cy + 11, 69], CHROME, 3.5);
  box(context, ax + 10, ax + 17, cy - 6, cy + 6, 69, 79, "#1b1b24", "#101016", METAL_DARK);
  neon(context, [[ax + 17.2, cy - 4, 71], [ax + 17.2, cy + 4, 71], [ax + 17.2, cy + 4, 77], [ax + 17.2, cy - 4, 77]], color, 1.5, active ? 10 : 0, true);
}

/* ---------------- Barbell rack (Strength): overhead press ---------------- */
function drawBarbell(context: CanvasRenderingContext2D, ax: number, ay: number, state: EquipmentState, flame: Flame, rider: ((pose: RiderPose) => void) | null) {
  const { active, hot, now, still, color } = state, cx = ax + 10, glow = hot || active ? 12 : 0;
  const press = active && !still ? 0.5 - 0.5 * Math.cos(now / 380) : 0;
  const barLift = active ? 60 + press * 22 : 58;
  shadow(context, cx, ay, 26, 42);
  box(context, cx - 22, cx + 22, ay - 40, ay + 40, 0, 3, "#231c2a", "#15111a", "#15111a");     // lifting platform
  neon(context, [[cx - 22, ay + 40, 3], [cx + 22, ay + 40, 3], [cx + 22, ay - 40, 3]], color, 1.5, glow);
  const upright = (y: number) => {
    box(context, cx - 10, cx - 2, y - 4, y + 4, 3, 5, METAL, METAL_DARK, METAL_DARK);
    tube(context, [cx - 6, y, 5], [cx - 6, y, 80], METAL, 5);
    tube(context, [cx - 6, y, 56], [cx, y, 56], CHROME, 2.5);                                        // J-hook
  };
  const plate = (y: number) => {
    const outer = ringYZ(cx, y, barLift, 11);
    face(context, outer, "#1c1c26");
    neon(context, outer, active ? "#ff8a3d" : color, 2, active ? 14 : glow, true);
    face(context, ringYZ(cx, y + (y > ay ? 1 : -1), barLift, 3.5, 10), CHROME);
  };
  const bar = () => tube(context, [cx, ay - 44, barLift], [cx, ay + 44, barLift], CHROME, 3);
  upright(ay - 28);
  plate(ay - 34);
  if (rider) {
    rider({ x: cx, y: ay, lift: 3, facing: "down", walking: false, frameMs: 0, dy: still ? 0 : press * -2 });
  }
  bar();
  plate(ay + 34);
  upright(ay + 28);
  if (active) {
    for (const y of [ay - 34, ay + 34]) {
      const [fx, fy] = v([cx, y, barLift + 10]);
      flame(context, fx, fy + 6, 0.45, now + y, still);
    }
  }
}

/* ---------------- Treadmill (Agility): belt scrolls, the Friend runs ---------------- */
function drawTreadmill(context: CanvasRenderingContext2D, ax: number, ay: number, state: EquipmentState, flame: Flame, rider: ((pose: RiderPose) => void) | null) {
  const { active, hot, now, still, color } = state, glow = hot || active ? 12 : 0;
  const x0 = ax - 15, x1 = ax + 15, y0 = ay - 34, y1 = ay + 34;
  shadow(context, ax, ay, 22, 40);
  box(context, x0, x1, y0, y1, 0, 9, METAL_DARK, "#1b1b24", "#262632");
  face(context, [[x0 + 3, y0 + 4, 9.2], [x1 - 3, y0 + 4, 9.2], [x1 - 3, y1 - 2, 9.2], [x0 + 3, y1 - 2, 9.2]], RUBBER);
  // Belt slats scroll toward the viewer while running.
  const offset = active && !still ? (now / 12) % 9 : 0;
  context.save();
  for (let k = 0; k < 8; k++) {
    const y = y0 + 4 + ((k * 9 + offset) % (y1 - y0 - 6));
    neon(context, [[x0 + 4, y, 9.4], [x1 - 4, y, 9.4]], active ? color + "88" : "#2a2a38", 1.2, 0);
  }
  context.restore();
  neon(context, [[x0 + 1, y1, 9], [x0 + 1, y0, 9]], color, 1.5, glow);
  neon(context, [[x1, y0, 9], [x1, y1, 9]], color, 1.5, glow);
  // Uprights, handrails and console at the far end.
  tube(context, [x0 + 2, y0 + 2, 9], [x0 + 2, y0 + 2, 60], METAL, 4);
  tube(context, [x1 - 2, y0 + 2, 9], [x1 - 2, y0 + 2, 60], METAL, 4);
  tube(context, [x0 + 2, y0 + 2, 48], [x0 + 2, y0 + 22, 44], CHROME, 2.5);
  tube(context, [x1 - 2, y0 + 2, 48], [x1 - 2, y0 + 22, 44], CHROME, 2.5);
  box(context, x0 + 1, x1 - 1, y0 - 2, y0 + 4, 58, 70, "#1b1b24", "#101016", METAL_DARK);
  const screen: P3[] = [[x0 + 5, y0 + 4.2, 60], [x1 - 5, y0 + 4.2, 60], [x1 - 5, y0 + 4.2, 68], [x0 + 5, y0 + 4.2, 68]];
  neon(context, screen, color, 1.5, active ? 10 : 0, true);
  if (active && !still) {
    const bars = 4;
    for (let k = 0; k < bars; k++) {
      const h = 2 + 5 * Math.abs(Math.sin(now / 150 + k));
      neon(context, [[x0 + 8 + k * 4.5, y0 + 4.3, 61], [x0 + 8 + k * 4.5, y0 + 4.3, 61 + h]], color, 1.5, 6);
    }
  }
  if (rider) {
    const stride = Math.floor(now / 55) % 8;
    // Speed streaks and a trail of fire behind the running Friend.
    if (active && !still) {
      for (let k = 0; k < 3; k++) {
        const t = ((now / 260 + k / 3) % 1);
        neon(context, [[ax - 8 + k * 8, ay + 12 + t * 20, 30 + k * 10], [ax - 8 + k * 8, ay + 22 + t * 20, 30 + k * 10]], color, 1.5, 6);
      }
      const [fx, fy] = v([ax, ay + 20, 9]);
      flame(context, fx, fy, 0.5, now, still);
    }
    rider({ x: ax, y: ay + 6, lift: 9, facing: "up", walking: true, frameMs: stride * 110, dy: still ? 0 : -Math.abs(Math.sin(now / 110)) * 2 });
  }
}

/* ---------------- Boxing reflex trainer (Defence): the ball swings back after each punch ---------------- */
function drawReflex(context: CanvasRenderingContext2D, ax: number, ay: number, state: EquipmentState, rider: ((pose: RiderPose) => void) | null) {
  const { active, hot, now, still, color } = state, glow = hot || active ? 12 : 0;
  const bx = ax + 12, by = ay - 6;
  const phase = active && !still ? Math.sin(now / 150) : 0;
  const sway = phase * 10; // world units along x; negative leans toward the Friend
  if (rider) {
    const punching = phase < -0.75;
    rider({ x: bx - 30, y: by, lift: 0, facing: "right", walking: punching, frameMs: punching ? 330 : 0, dx: punching ? 3 : 0 });
  }
  shadow(context, bx, by, 16, 12);
  // Weighted base: a short cylinder.
  floorEllipse(context, bx, by, 13, 13, METAL_DARK, 0);
  floorEllipse(context, bx, by, 13, 13, METAL, 7);
  const rimPoints = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return [bx + 13 * Math.cos(a), by + 13 * Math.sin(a), 7] as P3; });
  neon(context, rimPoints, color, 1.5, glow, true);
  // Spring and flexible pole.
  const spring: P3[] = Array.from({ length: 9 }, (_, i) => [bx + (i % 2 ? 2.5 : -2.5) + sway * 0.05 * i, by, 7 + i * 1.8] as P3);
  neon(context, spring, CHROME, 2, 0);
  const top: P3 = [bx + sway, by, 74];
  tube(context, [bx + sway * 0.1, by, 22], [bx + sway * 0.6, by, 50], CHROME, 3);
  tube(context, [bx + sway * 0.6, by, 50], top, CHROME, 3);
  // Ball.
  const [cxBall, cyBall] = v(top);
  context.save();
  if (hot || active) { context.shadowColor = color; context.shadowBlur = 16; }
  context.fillStyle = "#2c2038"; context.strokeStyle = OUTLINE; context.lineWidth = 2;
  context.beginPath(); context.arc(cxBall, cyBall - 8, 13, 0, Math.PI * 2); context.fill(); context.stroke();
  context.restore();
  context.strokeStyle = color; context.lineWidth = 2;
  context.beginPath(); context.arc(cxBall, cyBall - 8, 9, Math.PI * 1.1, Math.PI * 1.6); context.stroke();
  // Impact spark when the ball comes back to the Friend's fist.
  if (active && !still && phase < -0.85) {
    context.save();
    context.strokeStyle = "#fff4be"; context.lineWidth = 2; context.shadowColor = color; context.shadowBlur = 12;
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      context.beginPath();
      context.moveTo(cxBall - 15 + Math.cos(angle) * 5, cyBall - 8 + Math.sin(angle) * 5);
      context.lineTo(cxBall - 15 + Math.cos(angle) * 12, cyBall - 8 + Math.sin(angle) * 12);
      context.stroke();
    }
    context.restore();
  }
}
