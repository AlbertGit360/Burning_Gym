/* ------------------------------------------------------------------------ *
 * "Neon basement" scene art for the Burning Gym.
 *
 * Everything here is static vector art generated once as SVG strings and
 * loaded into images (data: URLs, allowed by the sandbox CSP's img-src).
 * GymWorld (gym-world.tsx) draws those images on its canvas and adds the
 * animated parts (flames, glows) and the canonical Friend sprite on top.
 *
 * All coordinates go through the SDK's own `project()`, so the art lines up
 * exactly with the world geometry used for walking and collision — this
 * file only changes how the room LOOKS, never where you can walk.
 * ------------------------------------------------------------------------ */
import { project, type WorldPoint } from "@rarefriends/friendsdk/world";

/** Same crop of the SDK's 1600 × 1200 projection that GameWorld uses. */
export const VIEW = Object.freeze({ x: 320, y: 330, width: 960, height: 640 });
/** Backing-store pixels per view pixel, so art stays sharp on hi-DPI screens. */
export const RENDER_SCALE = 2;

export const NEON = "#7cff5e";
export const FIRE = "#ff7a2e";
export const BG = "#0c0c14";

export type ViewPoint = readonly [number, number];
export function toView(x: number, y: number, lift = 0): ViewPoint {
  const [sx, sy] = project(x, y, lift);
  return [sx - VIEW.x, sy - VIEW.y];
}
const n = (value: number) => value.toFixed(1);
function points(poly: readonly WorldPoint[], lift = 0) {
  return poly.map(([x, y]) => { const [a, b] = toView(x, y, lift); return `${n(a)},${n(b)}`; }).join(" ");
}
export function worldRect(cx: number, cy: number, halfW: number, halfH: number): WorldPoint[] {
  return [[cx - halfW, cy - halfH], [cx + halfW, cy - halfH], [cx + halfW, cy + halfH], [cx - halfW, cy + halfH]];
}

/** Back edges of the room (the preset's octagon: x = 0 side, corner, y = 0 side, corner). */
const BACK_WALL: readonly WorldPoint[] = [[0, 336], [0, 48], [48, 0], [528, 0], [576, 48]];
export const WALL_HEIGHT = 150;
const SLAB_DEPTH = 24;
/** Angle of the y = 0 (right-hand) wall on screen, used to skew text painted on it. */
const RIGHT_WALL_SKEW = Math.atan((1.5 * 0.28) / (1.5 * 0.8660254038)) * 180 / Math.PI;

/** The Burning Gym sign's span along the right-hand wall (world x) and its height band (lift px). */
export const SIGN = Object.freeze({ from: 70, to: 210, bottom: 30, top: 80 });
/** Fire barrel in the far back corner — the room's "burn" focal point. */
export const BRAZIER: WorldPoint = [24, 24];

function isBackEdge(a: WorldPoint, b: WorldPoint) {
  const same = (p: WorldPoint, q: WorldPoint) => p[0] === q[0] && p[1] === q[1];
  return BACK_WALL.some((p, i) => i < BACK_WALL.length - 1
    && ((same(p, a) && same(BACK_WALL[i + 1], b)) || (same(p, b) && same(BACK_WALL[i + 1], a))));
}

function wallQuad(a: ViewPoint, b: ViewPoint, height: number, fill: string) {
  return `<polygon points="${n(a[0])},${n(a[1])} ${n(b[0])},${n(b[1])} ${n(b[0])},${n(b[1] - height)} ${n(a[0])},${n(a[1] - height)}" fill="${fill}"/>`;
}
/** A flat rectangle painted on a wall: along world x on the right wall, along world y on the left one. */
function wallPanel(side: "left" | "right", from: number, to: number, bottom: number, top: number) {
  const a = side === "right" ? toView(from, 0) : toView(0, from);
  const b = side === "right" ? toView(to, 0) : toView(0, to);
  return `${n(a[0])},${n(a[1] - bottom)} ${n(b[0])},${n(b[1] - bottom)} ${n(b[0])},${n(b[1] - top)} ${n(a[0])},${n(a[1] - top)}`;
}

function svgDocument(body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW.width * RENDER_SCALE}" height="${VIEW.height * RENDER_SCALE}" viewBox="0 0 ${VIEW.width} ${VIEW.height}">${body}</svg>`;
}

const DEFS = `<defs>
<pattern id="brick" width="28" height="14" patternUnits="userSpaceOnUse"><rect width="28" height="14" fill="#1b1624"/><path d="M0 13.5h28M0 6.5h28M7 0v7M21 7v7" stroke="#2a2236" stroke-width="1.2"/></pattern>
<linearGradient id="wallShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".6" stop-color="#000" stop-opacity="0"/></linearGradient>
<radialGradient id="firePool" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${FIRE}" stop-opacity=".5"/><stop offset="1" stop-color="${FIRE}" stop-opacity="0"/></radialGradient>
<radialGradient id="vignette" cx="50%" cy="45%" r="70%"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>`;

export type SceneZone = Readonly<{ polygon: readonly WorldPoint[]; color: string }>;
export type RingGeometry = Readonly<{ center: WorldPoint; half: number }>;

/**
 * Walls, sign, posters, floor, per-station floor zones and the ring's mat —
 * everything that is always BEHIND the Friend. `floor` is the world's own
 * walkable polygon, so the painted floor is exactly the walkable floor.
 */
export function buildBackdropSvg(floor: readonly WorldPoint[], zones: readonly SceneZone[], ring: RingGeometry) {
  let body = DEFS;
  // Back walls: brick, darker toward the ceiling, neon strip along the skirting.
  for (let i = 0; i < BACK_WALL.length - 1; i++) {
    const a = toView(...BACK_WALL[i]), b = toView(...BACK_WALL[i + 1]);
    body += wallQuad(a, b, WALL_HEIGHT, "url(#brick)") + wallQuad(a, b, WALL_HEIGHT, "url(#wallShade)");
  }
  body += `<polyline points="${points(BACK_WALL, WALL_HEIGHT)}" fill="none" stroke="#2a2236" stroke-width="3"/>`;

  // Stat posters on the left wall, one per stat colour, matching the HUD bars.
  const posters: readonly [number, string][] = [[62, "#ff5e5e"], [114, "#ffb85e"], [166, "#5ef0ff"], [218, "#c85eff"]];
  for (const [from, color] of posters) {
    body += `<polygon points="${wallPanel("left", from, from + 38, 28, 72)}" fill="${BG}" stroke="${color}" stroke-width="2" filter="url(#glow)" opacity=".9"/>`;
  }

  // BURNING GYM neon sign painted on the right wall.
  body += `<polygon points="${wallPanel("right", SIGN.from, SIGN.to, SIGN.bottom, SIGN.top)}" fill="#120a0a" stroke="${FIRE}" stroke-width="2.5" filter="url(#glow)"/>`;
  const [signX, signY] = toView((SIGN.from + SIGN.to) / 2, 0, (SIGN.bottom + SIGN.top) / 2);
  body += `<g transform="translate(${n(signX)} ${n(signY)}) skewY(${RIGHT_WALL_SKEW.toFixed(2)})"><text y="6" text-anchor="middle" font-family="'Courier New',monospace" font-weight="900" font-size="18" letter-spacing="2" fill="#ffb36b" filter="url(#glow)">BURNING GYM</text></g>`;

  body += `<polyline points="${points(BACK_WALL)}" fill="none" stroke="${NEON}" stroke-width="2" filter="url(#glow)"/>`;

  // Front slab faces (the floor's thickness), then the floor itself.
  for (let i = 0; i < floor.length; i++) {
    const a = floor[i], b = floor[(i + 1) % floor.length];
    const [ax, ay] = toView(...a), [bx, by] = toView(...b);
    // Only the near edges get a visible slab face; the far ones sit under the walls.
    if (isBackEdge(a, b)) continue;
    body += `<polygon points="${n(ax)},${n(ay)} ${n(bx)},${n(by)} ${n(bx)},${n(by + SLAB_DEPTH)} ${n(ax)},${n(ay + SLAB_DEPTH)}" fill="#07070b" stroke="#1f1f2c" stroke-width="1.5"/>`;
  }
  body += `<polygon points="${points(floor)}" fill="#191923"/>`;
  body += `<clipPath id="floorClip"><polygon points="${points(floor)}"/></clipPath><g clip-path="url(#floorClip)">`;
  // Rubber gym tiles.
  for (let g = 0; g <= 576; g += 48) {
    const [ax, ay] = toView(g, 0), [bx, by] = toView(g, 384);
    body += `<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}" stroke="#262635" stroke-width="1.2"/>`;
  }
  for (let g = 0; g <= 384; g += 48) {
    const [ax, ay] = toView(0, g), [bx, by] = toView(576, g);
    body += `<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}" stroke="#262635" stroke-width="1.2"/>`;
  }
  // Warm light spilling from the fire barrel.
  const [fx, fy] = toView(...BRAZIER);
  body += `<ellipse cx="${n(fx)}" cy="${n(fy + 14)}" rx="190" ry="80" fill="url(#firePool)"/>`;
  // One glowing mat per station, in that stat's HUD colour.
  for (const zone of zones) {
    body += `<polygon points="${points(zone.polygon)}" fill="${zone.color}" opacity=".10"/>`;
    body += `<polygon points="${points(zone.polygon)}" fill="none" stroke="${zone.color}" stroke-width="2" opacity=".85" filter="url(#glow)"/>`;
  }
  body += ringMat(ring);
  body += `</g>`;
  body += `<rect width="${VIEW.width}" height="${VIEW.height}" fill="url(#vignette)"/>`;
  return svgDocument(body);
}

/* ---------------- Training Ring: a real square on the floor grid ---------------- */

/** Corners of the ring in world space: back (far), right, front (near), left. */
export function ringCorners({ center: [cx, cy], half }: RingGeometry) {
  return {
    back: [cx - half, cy - half] as WorldPoint, right: [cx + half, cy - half] as WorldPoint,
    front: [cx + half, cy + half] as WorldPoint, left: [cx - half, cy + half] as WorldPoint,
  };
}
const POST_HEIGHT = 46;
const ROPE_LIFTS = [16, 28, 40] as const;
const ROPE_COLORS = ["#ff5e1a", "#e6ffcf", "#ff5e1a"] as const;

function ringMat(ring: RingGeometry) {
  const c = ringCorners(ring), square = [c.back, c.right, c.front, c.left];
  const inner = ringCorners({ center: ring.center, half: ring.half - 8 });
  return `<polygon points="${points(square)}" fill="#141420" stroke="#000" stroke-width="3"/>`
    + `<polygon points="${points([inner.back, inner.right, inner.front, inner.left])}" fill="#23232f" stroke="${NEON}" stroke-width="2" filter="url(#glow)"/>`
    + `<polygon points="${points(worldRect(ring.center[0], ring.center[1], 16, 16))}" fill="none" stroke="${NEON}" stroke-width="1.2" opacity=".5"/>`;
}
function post([x, y]: WorldPoint) {
  const [bx, by] = toView(x, y), top = by - POST_HEIGHT;
  return `<rect x="${n(bx - 3)}" y="${n(top)}" width="6" height="${POST_HEIGHT}" fill="#c9c9d6" stroke="#000" stroke-width="1.5"/>`
    + `<rect x="${n(bx - 5)}" y="${n(top - 4)}" width="10" height="16" rx="2" fill="${FIRE}" stroke="#000" stroke-width="1.5"/>`;
}
function ropes(a: WorldPoint, b: WorldPoint) {
  return ROPE_LIFTS.map((lift, i) => {
    const [ax, ay] = toView(a[0], a[1], lift), [bx, by] = toView(b[0], b[1], lift);
    return `<line x1="${n(ax)}" y1="${n(ay)}" x2="${n(bx)}" y2="${n(by)}" stroke="${ROPE_COLORS[i]}" stroke-width="2.4" stroke-linecap="round"/>`;
  }).join("");
}
/** Posts and ropes on the two far sides — drawn before a Friend standing inside the ring. */
export function buildRingBackSvg(ring: RingGeometry) {
  const c = ringCorners(ring);
  return svgDocument(post(c.back) + ropes(c.left, c.back) + ropes(c.back, c.right) + post(c.left) + post(c.right));
}
/** Posts and ropes on the two near sides — drawn after a Friend standing inside the ring. */
export function buildRingFrontSvg(ring: RingGeometry) {
  const c = ringCorners(ring);
  return svgDocument(ropes(c.left, c.front) + ropes(c.front, c.right) + post(c.front));
}
/** The sparring dummy in the middle of the ring (same design as before, upright on the ring's centre). */
export function buildDummySvg(ring: RingGeometry) {
  const [x, y] = toView(...ring.center);
  return svgDocument(`<g transform="translate(${n(x)} ${n(y)}) scale(1.15)">
<ellipse cx="0" cy="0" rx="12" ry="5" fill="#000" opacity=".6"/>
<rect x="-2" y="-30" width="4" height="30" fill="#111"/>
<path d="M-9 -30 L-19 -21 M9 -30 L19 -21" stroke="#111" stroke-width="5" stroke-linecap="round"/>
<rect x="-9" y="-36" width="18" height="26" rx="8" fill="#e8b774" stroke="#000" stroke-width="2"/>
<circle cx="0" cy="-24" r="7" fill="none" stroke="#ff5e5e" stroke-width="2"/><circle cx="0" cy="-24" r="3.5" fill="#ff5e5e"/>
<circle cx="0" cy="-44" r="8" fill="#e8b774" stroke="#000" stroke-width="2"/></g>`);
}
