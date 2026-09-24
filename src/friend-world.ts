/**
 * Browser-safe adaptation of the canonical Rare Friends isometric-world renderer.
 * Vector prop artwork, terrain clipping, slab walls and projection are preserved.
 * Character pixels are supplied by the caller; no character snapshots are bundled.
 */
import collection from "./friend-worlds.json" with { type: "json" };

export const CANVAS = Object.freeze({ width: 1600, height: 1200 });
export const PALETTE = Object.freeze({ white: "#FFFFFF", black: "#000000", accent: "#CCFF00" });
/** Optional game colors; canonical Friend pixels remain black and white. */
export const GAME_PALETTE = Object.freeze({
  meadow: "#B9D984", pond: "#7DB4DB", sun: "#F2CE68", coral: "#ED927E", lilac: "#B3A0D8",
});
export const PROJECTION = Object.freeze({ a: 0.8660254038, b: 0.28, scale: 1.5, width: 576, height: 384, cx: 800, cy: 690 });
export const PROP_CANVAS = Object.freeze({ width: 240, height: 240, anchorX: 120, anchorY: 180 });
export const PROP_TYPES = Object.freeze([
  "tree", "flower", "bench", "planter", "terminal", "crate", "pipe", "tank", "crystal", "rock",
  "vent", "antenna", "solar", "dish", "buoy", "reeds", "bridge", "circuit",
] as const);
export type WorldPropType = typeof PROP_TYPES[number];
export type WorldPoint = readonly [number, number];
type XY = readonly number[];
export type WorldRect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type WorldAnchor = Readonly<{ x: number; y: number; sprite?: number }>;
export type WorldProp = Readonly<{
  type: WorldPropType; x: number; y: number; scale?: number;
  /** Optional local world-coordinate footprint, scaled with the prop. Null is passable. */
  footprint?: WorldRect | null;
}>;
export type WorldSignal = Readonly<{ x: number; y: number; kind: "currency" | "node" }>;
export type WorldChunk = WorldRect & Readonly<{ stage: "void" | "wireframe" | "floating"; lift?: number }>;
export type WorldConfig = Readonly<{
  id: string; name: string; family: string; setting: string; shape: string; summary: string;
  variant: "complete" | "loading";
  geometry: Readonly<{ polygons: readonly (readonly WorldPoint[])[]; holes: readonly (readonly WorldPoint[])[]; depth: number }>;
  props: readonly WorldProp[];
  /** Canonical composition anchors only. Rendering never resolves their legacy sprite indexes. */
  actors: readonly WorldAnchor[];
  paths: readonly Readonly<{ points: readonly WorldPoint[]; width: number }>[];
  patches: readonly (WorldRect & Readonly<{ pattern: "dither" | "dense" | "grid" | "hatch" | "water" }>)[];
  signals: readonly WorldSignal[];
  missingChunks: readonly WorldChunk[];
  collision?: Readonly<{ blocked: readonly WorldRect[] }>;
}>;
export type WorldActor = Readonly<{ id?: string; x: number; y: number; rows: readonly string[]; pixelScale?: number }>;
export type WorldRenderOptions = Readonly<{
  actors?: readonly WorldActor[];
  signals?: boolean;
  background?: "transparent" | "black";
  /** Apply GAME_PALETTE to terrain and props. Monochrome artwork is the default. */
  color?: boolean;
}>;
export type PropRenderOptions = Readonly<{ color?: boolean }>;
export type WorldObjectLayer = Readonly<{
  kind: "prop" | "signal"; x: number; y: number; depth: number; svg: string;
}>;
export type WorldLayers = Readonly<{
  width: number; height: number; terrainSvg: string; objects: readonly WorldObjectLayer[];
}>;

const trustedWorlds = new WeakSet<object>();
const boundaryCache = new WeakMap<object, readonly (readonly XY[])[]>();
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]!);

function finite(value: unknown, label: string, min = -1_000_000, max = 1_000_000): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  if (value < min || value > max) throw new RangeError(`${label} must be between ${min} and ${max}.`);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new TypeError(`${label} must be nonempty text of at most ${max} characters.`);
  }
  return value;
}
function array(value: unknown, label: string, max = 128): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label} must be an array with at most ${max} entries.`);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new TypeError(`Unsupported ${label}: ${String(value)}.`);
  return value as T;
}
function point(value: unknown, label: string, bounded = true): WorldPoint {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} must be [x, y].`);
  finite(value[0], `${label}.x`, bounded ? 0 : -1_000_000, bounded ? PROJECTION.width : 1_000_000);
  finite(value[1], `${label}.y`, bounded ? 0 : -1_000_000, bounded ? PROJECTION.height : 1_000_000);
  return [value[0], value[1]];
}
function anchor(value: unknown, label: string) {
  const item = record(value, label);
  const [x, y] = point([item.x, item.y], label);
  return { x, y };
}
function rectangle(value: unknown, label: string, relative = false): WorldRect {
  const item = record(value, label);
  finite(item.x, `${label}.x`, relative ? -576 : 0, 576);
  finite(item.y, `${label}.y`, relative ? -384 : 0, 384);
  finite(item.w, `${label}.w`, 0.001, 576);
  finite(item.h, `${label}.h`, 0.001, 384);
  if (!relative && (item.x + item.w > 576 || item.y + item.h > 384)) throw new RangeError(`${label} extends beyond the world coordinate grid.`);
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function polygonPoints(value: unknown, label: string) {
  const points = array(value, label).map((entry, index) => point(entry, `${label}[${index}]`));
  if (points.length < 3) throw new TypeError(`${label} needs at least three vertices.`);
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    if (a[0] === b[0] && a[1] === b[1]) throw new TypeError(`${label} contains a zero-length edge.`);
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(twiceArea) < 0.001) throw new TypeError(`${label} must enclose an area.`);
  const cross = (a: WorldPoint, b: WorldPoint, c: WorldPoint) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (a: WorldPoint, b: WorldPoint, p: WorldPoint) => Math.abs(cross(a, b, p)) < 1e-8
    && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (j === i + 1 || i === 0 && j === points.length - 1) continue;
    const a = points[i], b = points[(i + 1) % points.length], c = points[j], d = points[(j + 1) % points.length];
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
      || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) {
      throw new TypeError(`${label} must be a simple polygon without crossing edges.`);
    }
  }
  return points;
}

/** Validate untrusted JSON once, then share the immutable result with rendering and movement. */
export function validateWorld(value: unknown): WorldConfig {
  if (value && typeof value === "object" && trustedWorlds.has(value)) return value as WorldConfig;
  const source = record(value, "world"), geometry = record(source.geometry, "geometry");
  const polygons = array(geometry.polygons, "geometry.polygons", 16).map((entry, index) => polygonPoints(entry, `polygons[${index}]`));
  if (!polygons.length) throw new TypeError("World geometry needs a polygon.");
  const holes = array(geometry.holes, "geometry.holes", 16).map((entry, index) => polygonPoints(entry, `holes[${index}]`));
  if ([...polygons, ...holes].reduce((sum, loop) => sum + loop.length, 0) > 512) throw new RangeError("World geometry supports at most 512 vertices.");
  const depth = geometry.depth ?? 18;
  finite(depth, "geometry.depth", 1, 100);
  const props = array(source.props, "props").map((entry, index): WorldProp => {
    const item = record(entry, `props[${index}]`);
    const type = choice(item.type, PROP_TYPES, "prop type");
    const scale = item.scale ?? 1;
    finite(scale, "prop.scale", 0.1, 4);
    return { ...anchor(item, `props[${index}]`), type, scale,
      ...(item.footprint === undefined ? {} : { footprint: item.footprint === null ? null : rectangle(item.footprint, "prop.footprint", true) }) };
  });
  const actors = array(source.actors, "actors").map((entry, index): WorldAnchor => {
    const item = record(entry, `actors[${index}]`);
    if (item.sprite !== undefined) {
      finite(item.sprite, "actor.sprite", 0, 255);
      if (!Number.isInteger(item.sprite)) throw new TypeError("actor.sprite must be an integer index.");
    }
    return { ...anchor(item, `actors[${index}]`), ...(item.sprite === undefined ? {} : { sprite: item.sprite as number }) };
  });
  const signals = array(source.signals, "signals").map((entry, index): WorldSignal => {
    const item = record(entry, `signals[${index}]`);
    return { ...anchor(item, `signals[${index}]`), kind: choice(item.kind, ["currency", "node"], "signal kind") };
  });
  const paths = array(source.paths, "paths", 64).map((entry, index) => {
    const item = record(entry, `paths[${index}]`);
    const points = array(item.points, "path.points").map((entry, index) => point(entry, `path.points[${index}]`));
    if (points.length < 2) throw new TypeError("A path needs at least two points.");
    const width = item.width ?? 20;
    finite(width, "path.width", 1, 96);
    return { points, width };
  });
  const patches = array(source.patches, "patches").map((entry, index) => {
    const item = record(entry, `patches[${index}]`);
    return { ...rectangle(item, `patches[${index}]`), pattern: choice(item.pattern, ["dither", "dense", "grid", "hatch", "water"], "patch pattern") };
  });
  const missingChunks = array(source.missingChunks, "missingChunks", 64).map((entry, index): WorldChunk => {
    const item = record(entry, `missingChunks[${index}]`), rect = rectangle(item, `missingChunks[${index}]`);
    if (rect.w !== 48 || rect.h !== 48 || rect.x % 48 !== 0 || rect.y % 48 !== 0) throw new RangeError("Missing chunks must use the 48 × 48 world grid.");
    const stage = choice(item.stage, ["void", "wireframe", "floating"], "chunk stage"), lift = item.lift ?? (stage === "floating" ? 24 : 0);
    finite(lift, "chunk.lift", stage === "floating" ? 1 : 0, stage === "floating" ? 160 : 0);
    return { ...rect, stage, lift };
  });
  const collision = source.collision === undefined ? undefined : record(source.collision, "collision");
  const world: WorldConfig = {
    id: text(source.id, "world.id", 100), name: text(source.name, "world.name", 120),
    family: text(source.family, "world.family", 100), setting: text(source.setting, "world.setting", 120),
    shape: text(source.shape, "world.shape", 120), summary: text(source.summary, "world.summary"),
    variant: choice(source.variant, ["complete", "loading"], "world variant"),
    geometry: { polygons, holes, depth }, props, actors, signals, paths, patches, missingChunks,
    ...(collision ? { collision: { blocked: array(collision.blocked, "collision.blocked").map((entry, index) => rectangle(entry, `collision.blocked[${index}]`)) } } : {}),
  };
  if (world.variant === "complete" && missingChunks.length) throw new TypeError("A complete world cannot contain missing chunks.");
  if (world.variant === "loading" && !missingChunks.length) throw new TypeError("A loading world needs missing chunks.");
  for (const item of [...props, ...actors, ...signals]) {
    if (!containsLoaded(world, [item.x, item.y])) throw new RangeError(`World anchor (${item.x}, ${item.y}) is outside loaded ground.`);
  }
  deepFreeze(world);
  trustedWorlds.add(world);
  return world;
}

const n = (value: number) => Math.round(value * 1000) / 1000;
export function project(x: number, y: number, lift = 0): [number, number] {
  finite(x, "x"); finite(y, "y"); finite(lift, "lift");
  const { a, b, scale, width, height, cx, cy } = PROJECTION;
  return [n(cx + scale * a * (x-y-(width-height)/2)), n(cy + scale*b*(x+y-(width+height)/2)-lift)];
}
const pointList = (points: readonly XY[]) => points.map(p => p.map(n).join(',')).join(' ');
const polygon = (points: readonly XY[], attrs='') => `<polygon points="${pointList(points)}" ${attrs}/>`;
const line = (points: readonly XY[], attrs='') => `<polyline points="${pointList(points)}" fill="none" ${attrs}/>`;
const planeMatrix = () => { const { a,b,scale,width,height,cx,cy }=PROJECTION; return `matrix(${scale*a} ${scale*b} ${-scale*a} ${scale*b} ${cx-scale*a*(width-height)/2} ${cy-scale*b*(width+height)/2})`; };
const rectPoly = ({x,y,w,h}: WorldRect): XY[] => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];

function inPolygon([x,y]: XY, points: readonly XY[]) {
  let inside = false;
  for (let i=0,j=points.length-1;i<points.length;j=i++) {
    const [xi,yi]=points[i], [xj,yj]=points[j];
    if ((yi>y)!==(yj>y) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
function containsLoaded(world: WorldConfig, point: XY) {
  return world.geometry.polygons.some(p=>inPolygon(point,p)) &&
    !(world.geometry.holes||[]).some(p=>inPolygon(point,p)) &&
    !(world.missingChunks||[]).some(r=>inPolygon(point,rectPoly(r)));
}

// Split edges at every cutout intersection, then retain the actual material/void boundary.
// This creates true holes and exposed slab walls, including chunks cut out of an outer edge.
function materialBoundary(world: WorldConfig) {
  const loops=[...world.geometry.polygons,...(world.geometry.holes||[]),...(world.missingChunks||[]).map(rectPoly)];
  const edges=loops.flatMap(p=>p.map((a,i)=>[a,p[(i+1)%p.length]]));
  const cross=(a: XY,b: XY)=>a[0]*b[1]-a[1]*b[0], sub=(a: XY,b: XY)=>[a[0]-b[0],a[1]-b[1]];
  const result: XY[][]=[], seen=new Set<string>();
  for(const [a,b] of edges) {
    const v=sub(b,a), vv=v[0]*v[0]+v[1]*v[1], ts=[0,1];
    if(vv<1e-8)continue;
    for(const [c,d] of edges) {
      const w=sub(d,c), ca=sub(c,a), den=cross(v,w);
      if(Math.abs(den)>1e-8) {
        const t=cross(ca,w)/den, u=cross(ca,v)/den;
        if(t>1e-7&&t<1-1e-7&&u>=-1e-7&&u<=1+1e-7)ts.push(t);
      } else if(Math.abs(cross(ca,v))<1e-7) {
        for(const q of [c,d]) { const t=((q[0]-a[0])*v[0]+(q[1]-a[1])*v[1])/vv; if(t>1e-7&&t<1-1e-7)ts.push(t); }
      }
    }
    ts.sort((x,y)=>x-y);
    for(let i=1;i<ts.length;i++) {
      if(ts[i]-ts[i-1]<1e-7)continue;
      let p=[a[0]+v[0]*ts[i-1],a[1]+v[1]*ts[i-1]], q=[a[0]+v[0]*ts[i],a[1]+v[1]*ts[i]];
      const m=[(p[0]+q[0])/2,(p[1]+q[1])/2], e=.04/Math.sqrt(vv), normal=[-v[1]*e,v[0]*e];
      const left=containsLoaded(world,[m[0]+normal[0],m[1]+normal[1]]), right=containsLoaded(world,[m[0]-normal[0],m[1]-normal[1]]);
      if(left===right)continue;
      if(!left)[p,q]=[q,p];
      const key=[p,q].map(k=>k.map(n).join(',')).sort().join('|');
      if(!seen.has(key)){seen.add(key);result.push([p,q]);}
    }
  }
  return result;
}

function definitions(id: string, color = false) {
  const patterns = `<pattern id="${id}-dither" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${color ? GAME_PALETTE.sun : '#fff'}"/><rect width="1" height="1" fill="#000"/><rect x="2" y="2" width="1" height="1" fill="#000"/></pattern>
<pattern id="${id}-dense" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${color ? GAME_PALETTE.meadow : '#fff'}"/><path d="M0 0h2v2H0zM2 2h2v2H2z" fill="#000"/></pattern>
<pattern id="${id}-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M14 16h4M16 14v4" stroke="#000" stroke-width=".8"/></pattern>
<pattern id="${id}-hatch" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="${color ? GAME_PALETTE.coral : '#fff'}"/><path d="M-1 1l2-2M0 7L7 0M6 8l2-2" stroke="#000"/></pattern>
<pattern id="${id}-water" width="44" height="30" patternUnits="userSpaceOnUse"><rect width="44" height="30" fill="${color ? GAME_PALETTE.pond : '#000'}"/><path d="M3 6h18m9 14h11M5 23h7" stroke="#fff" stroke-width="2"/></pattern>`;
  if (!color) return patterns;
  return patterns + Object.entries(GAME_PALETTE).map(([name, fill]) =>
    `<pattern id="${id}-dither-${name}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${fill}"/><rect width="1" height="1" fill="#000"/><rect x="2" y="2" width="1" height="1" fill="#000"/></pattern>` +
    `<pattern id="${id}-dense-${name}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${fill}"/><path d="M0 0h2v2H0zM2 2h2v2H2z" fill="#000"/></pattern>`
  ).join('');
}

function box(w: number,d: number,h: number,fill='#fff',id='') {
  // Small prop slabs use exactly the same shallow iso ratio as the ground.
  const a=.8660254038,b=.28, pts=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]].map(([x,y])=>[a*(x-y),b*(x+y)]);
  const top=pts.map(([x,y])=>[x,y-h]);
  return `<g stroke="#000" stroke-width="2" stroke-linejoin="miter">${polygon([top[1],top[2],pts[2],pts[1]],`fill="${id?`url(#${id}-dither)`:'#fff'}"`)}${polygon([top[2],top[3],pts[3],pts[2]],'fill="#000" stroke="#fff" stroke-width="1.5"')}${polygon(top,`fill="${fill}"`)}</g>`;
}

function tree(id: string) {
  return `<path d="M-5-15h10v20H-5z" fill="url(#${id}-dense)" stroke="#000" stroke-width="2"/><path d="M-28-19v-16h-8v-24h8v-16h16v-8h24v8h16v16h8v24h-8v16z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M-27-23h16v-8h8v-8h8v-8h24v12h-8v12H5v8h-24z" fill="url(#${id}-dense)"/><path d="M-18-62h8v-8h10M9-65h10v10M-26-47h8" fill="none" stroke="#000" stroke-width="3"/>`;
}
function flower() {
  return `<path d="M-2 0h4v-18h-4zM-2-6h-6v-4h6M2-3h6v-4H2" fill="#000"/><path d="M-6-22h12v8H-6zM-2-26h4v16h-4z" fill="#fff" stroke="#000" stroke-width="2"/><rect x="-2" y="-20" width="4" height="4" fill="#000"/>`;
}
function canonicalPropArtwork(type: WorldPropType,id: string) {
  const dither=`url(#${id}-dither)`;
  switch(type) {
    case 'tree': return tree(id);
    case 'flower': return flower();
    case 'bench': return `<path d="M-34-9v15m53-12v14M-28-38v28m53-7v-28" stroke="#000" stroke-width="5"/>${box(58,18,17,'#fff',id)}<path d="M-28-38l53 17v-11l-53-17z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M-23-40l43 14" stroke="#000"/>`;
    case 'planter': return `${box(44,30,19,dither,id)}<g transform="translate(-10 -24) scale(.85)">${flower()}</g><path d="M8-23v-20m0 8l-10-9m10 4l10-13M-6-19v-26m0 9l-10-8m10 1l7-9" stroke="#000" stroke-width="3" fill="none"/><path d="M-16-42h8v7h-8M15-55h7v7h-7" fill="#fff" stroke="#000" stroke-width="2"/>`;
    case 'terminal': return `${box(28,26,12,'#fff',id)}<path d="M-17-9v-56l33 10v55z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M16 0l11-5v-56l-11 6" fill="${dither}" stroke="#000" stroke-width="2"/><path d="M-11-54l21 6v22l-21-6z" fill="#000"/><path d="M-6-44l5 2m-5 5l12 4" stroke="#CCFF00" stroke-width="2"/><path d="M-10-22l18 5m-18 5l12 4" stroke="#000" stroke-width="3"/>`;
    case 'crate': return `${box(31,31,30,dither,id)}<path d="M0 8v-30M-26-10l26 8 26-8M-23-26l22 7 21-7" stroke="#000" stroke-width="3"/><path d="M-15-4l7 3v5l-7-3" fill="#fff"/>`;
    case 'pipe': return `<path d="M-30 0v-24h13v-24h36v34h12" stroke="#000" stroke-width="16" fill="none" stroke-linejoin="miter"/><path d="M-30 0v-24h13v-24h36v34h12" stroke="#fff" stroke-width="10" fill="none" stroke-linejoin="miter"/><path d="M-36-6h12M-23-29h12M1-55v14M12-23h14" stroke="#000" stroke-width="3"/><rect x="27" y="-22" width="7" height="15" fill="#fff" stroke="#000" stroke-width="2"/>`;
    case 'tank': return `<path d="M-20-6v8m40-8v8" stroke="#000" stroke-width="5"/><path d="M-26-17v-42l8-11h32l12 11v42l-12 9h-32z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M7-68h8l11 10v41l-12 9H7z" fill="${dither}"/><path d="M-26-56l8 5h32l12-5m-52 29l8 5h32l12-5" fill="none" stroke="#000" stroke-width="3"/><path d="M-7-70v-11H7v11" fill="#fff" stroke="#000" stroke-width="2"/><rect x="-14" y="-43" width="12" height="9" fill="#000"/><rect x="-11" y="-40" width="6" height="3" fill="#CCFF00"/>`;
    case 'crystal': return `<g stroke="#000" stroke-width="2" stroke-linejoin="miter"><path d="M-30-4l-9-26 6-21 17 13L-9-8z" fill="#fff"/><path d="M-33-49l8 22 16 19" fill="none"/><path d="M-14 2l-4-65L-2-94l19 22 3 61L3 8z" fill="#fff"/><path d="M-2-94l4 32 1 70 17-19-3-61z" fill="${dither}"/><path d="M-18-63L2-62l15-10" fill="none"/><path d="M17-4l6-35 17-15 7 24-17 31z" fill="#fff"/><path d="M40-54l-6 24-4 31" fill="none"/></g>`;
    case 'rock': return `<path d="M-25-8l6-17 22-6 22 13 5 15L8 7l-26-5z" fill="${dither}" stroke="#000" stroke-width="2"/><path d="M-19-25l17 11 27-4M-2-14L8 7" stroke="#000" stroke-width="2" fill="none"/>`;
    case 'vent': return `${box(47,37,29,'#fff',id)}<path d="M-18-35l29 9m-35-5l29 9m-35-5l29 9m-35-5l29 9" stroke="#000" stroke-width="3"/><path d="M24-7v-12m6 10v-12" stroke="#000" stroke-width="2"/>`;
    case 'antenna': return `${box(30,27,10,dither,id)}<path d="M-12-8L0-96 14-7M-7-37h15M-10-18h22M-4-60h9M0-96v-17M-13-87h27M-8-99H8" stroke="#000" stroke-width="3" fill="none"/><path d="M-12-8L0-96 14-7" stroke="#fff" stroke-width="1" fill="none"/><rect x="-3" y="-117" width="6" height="6" fill="#CCFF00" stroke="#000" stroke-width="1.5"/>`;
    case 'solar': return `<path d="M-19-17v23m40-11v14M-19-9L21 4" stroke="#000" stroke-width="4"/><path d="M-42-51L7-65 47-29-2-14z" fill="#000" stroke="#fff" stroke-width="2"/><path d="M-42-51L7-65 47-29-2-14zM-30-39l49-14M-16-27l49-14M-30-55L10-18M-18-58L22-22M-5-61l40 36" stroke="#fff" stroke-width="1.3" fill="none"/><path d="M-42-51L7-65 47-29-2-14z" fill="none" stroke="#000" stroke-width="2"/>`;
    case 'dish': return `${box(40,33,12,'#fff',id)}<path d="M-9-7l8-40 12 6 7 39" fill="${dither}" stroke="#000" stroke-width="2"/><path d="M-39-77L25-44C7-16-24-20-39-77Z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M-39-77L25-44l-5 8-55-29z" fill="${dither}" stroke="#000" stroke-width="2"/><path d="M-16-52L5-84M-30-67L5-84 14-49" fill="none" stroke="#fff" stroke-width="4"/><path d="M-16-52L5-84M-30-67L5-84 14-49" fill="none" stroke="#000" stroke-width="2"/><rect x="2" y="-88" width="7" height="6" fill="#CCFF00" stroke="#000" stroke-width="2"/>`;
    case 'buoy': return `<path d="M-21-1l12-8H9l12 8L8 6H-8z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M-10-3l5-30H5l5 30z" fill="#fff" stroke="#000" stroke-width="2"/><path d="M-7-15H7" stroke="#000" stroke-width="7"/><path d="M0-33v-19h14v10H0" fill="#CCFF00" stroke="#000" stroke-width="2"/>`;
    case 'reeds': return `<path d="M-13 1v-39M-1 2v-51M11 0v-32M-13-7l-11-11M-1-12L8-25M11-7l12-12" stroke="#fff" stroke-width="4.5" fill="none"/><path d="M-13 1v-39M-1 2v-51M11 0v-32M-13-7l-11-11M-1-12L8-25M11-7l12-12" stroke="#000" stroke-width="2.5" fill="none"/><path d="M-16-44h6v13h-6zM-4-56h6v14h-6zM8-38h6v12H8z" fill="#fff" stroke="#000" stroke-width="2"/>`;
    case 'bridge': return `${box(86,26,10,'#fff',id)}<path d="M-42-18l76 24M-29-30l76 24" stroke="#000" stroke-width="3"/><path d="M-42-18v-15m25 23v-15m25 23v-15m26 23v-15" stroke="#000" stroke-width="3"/>`;
    case 'circuit': return `<path d="M-40-12h25v-20h32v21h24M-28 4h24v-20h20" stroke="#000" stroke-width="3" fill="none"/><rect x="-4" y="-39" width="17" height="13" fill="#000"/><rect x="0" y="-35" width="9" height="5" fill="#CCFF00"/>`;
    default: throw new Error(`Unsupported prop type: ${type}`);
  }
}

const PROP_COLORS: Readonly<Record<WorldPropType, keyof typeof GAME_PALETTE>> = Object.freeze({
  tree: 'meadow', flower: 'coral', bench: 'sun', planter: 'coral', terminal: 'lilac', crate: 'sun',
  pipe: 'pond', tank: 'pond', crystal: 'lilac', rock: 'lilac', vent: 'coral', antenna: 'lilac',
  solar: 'pond', dish: 'lilac', buoy: 'coral', reeds: 'sun', bridge: 'sun', circuit: 'lilac',
});

/** Repaint canonical surfaces without changing paths, outlines or projection. */
function paintedPropArtwork(type: WorldPropType, id: string, color: boolean) {
  const artwork = canonicalPropArtwork(type, id);
  if (!color) return artwork;
  const name = PROP_COLORS[type], fill = GAME_PALETTE[name];
  let painted = artwork.split('fill="#fff"').join(`fill="${fill}"`)
    .split(`#${id}-dither)`).join(`#${id}-dither-${name})`)
    .split(`#${id}-dense)`).join(`#${id}-dense-${name})`)
    .split('#CCFF00').join(GAME_PALETTE.sun);
  if (type === 'solar') painted = painted.replace('fill="#000"', `fill="${fill}"`);
  return painted;
}

function signalArtwork(signal: WorldSignal, color = false) {
  const [x,y]=project(signal.x,signal.y);
  const accent = color ? GAME_PALETTE.sun : '#CCFF00';
  if(signal.kind==='node')return `<g transform="translate(${x} ${y})"><path d="M-6 0l6-3 6 3-6 3z" fill="${accent}" stroke="#000" stroke-width="1.5"/><path d="M0-3v-10" stroke="#000" stroke-width="2"/><rect x="-3" y="-16" width="6" height="6" fill="${accent}" stroke="#000" stroke-width="1.5"/></g>`;
  // The original collection $ glyph, with no plus sign.
  return `<g transform="translate(${n(x-12)} ${n(y-2)})"><path d="M250 500L250 625L375 625L375 750L500 750L500 625L625 625L625 500ZM250 -125L250 0L125 0L125 125L500 125L500 250L250 250L250 375L125 375L125 500L250 500L250 375L500 375L500 250L625 250L625 125L500 125L500 0L375 0L375 -125Z" transform="scale(.032 -.032)" fill="${accent}" stroke="#000" stroke-width="62.5" paint-order="stroke"/></g>`;
}

function chunkArtwork(chunk: WorldChunk,index: number,id: string,color = false) {
  const base=rectPoly(chunk).map(([x,y])=>project(x,y));
  const accent=color ? GAME_PALETTE.lilac : '#CCFF00';
  if(chunk.stage==='void') {
    return `<g data-chunk="${index}" data-stage="void" stroke="${accent}" stroke-width="1.5">${base.map(([x,y])=>`<path d="M${n(x-3)} ${y}h6M${x} ${n(y-3)}v6"/>`).join('')}</g>`;
  }
  const lift=chunk.stage==='floating'?(chunk.lift||24):0;
  const top=base.map(([x,y])=>[x,y-lift]);
  let s=`<g data-chunk="${index}" data-stage="${esc(chunk.stage)}">`;
  if(lift) {
    s+=line([...base,base[0]],`stroke="${accent}" stroke-width="1.1" stroke-dasharray="4 7"`);
    for(let i=0;i<4;i++)s+=line([base[i],top[i]],`stroke="${accent}" stroke-width="1" stroke-dasharray="3 5"`);
    s+=polygon([top[1],top[2],[top[2][0],top[2][1]+6],[top[1][0],top[1][1]+6]],'fill="#000" stroke="#fff" stroke-width="1"');
    s+=polygon([top[2],top[3],[top[3][0],top[3][1]+6],[top[2][0],top[2][1]+6]],'fill="#000" stroke="#fff" stroke-width="1"');
    s+=polygon(top,`fill="url(#${id}-dither)" stroke="#fff" stroke-width="1.2"`);
    // Small lime corner indicators leave the incomplete cell mostly monochrome.
    s+=top.map(([x,y])=>`<path d="M${n(x-3)} ${n(y-1)}h6" stroke="${accent}" stroke-width="2"/>`).join('');
  } else {
    s+=line([...top,top[0]],`stroke="${accent}" stroke-width="1.5"`);
    s+=line([top[0],top[2]],`stroke="${accent}" stroke-width=".9" stroke-dasharray="2 5"`);
    s+=line([top[1],top[3]],`stroke="${accent}" stroke-width=".9" stroke-dasharray="2 5"`);
  }
  return s+'</g>';
}


/** Inverse of the canonical camera. Returned world coordinates are not rounded. */
export function unproject(screenX: number, screenY: number, lift = 0): [number, number] {
  finite(screenX, "screenX"); finite(screenY, "screenY"); finite(lift, "lift");
  const difference = (screenX - PROJECTION.cx) / (PROJECTION.scale * PROJECTION.a) + (PROJECTION.width - PROJECTION.height) / 2;
  const sum = (screenY + lift - PROJECTION.cy) / (PROJECTION.scale * PROJECTION.b) + (PROJECTION.width + PROJECTION.height) / 2;
  return [(sum + difference) / 2, (sum - difference) / 2];
}

/** Ground membership excludes every courtyard hole and all three missing-chunk stages. */
export function worldContains(world: WorldConfig, location: WorldPoint) {
  return containsLoaded(validateWorld(world), point(location, "location", false));
}

/** Game collision additions; these footprints are not claimed to be on-chain terrain data. */
export const PROP_FOOTPRINTS: Readonly<Record<WorldPropType, Readonly<{ w: number; h: number }> | null>> = deepFreeze({
  tree: { w: 12, h: 12 }, flower: null, bench: { w: 58, h: 18 }, planter: { w: 44, h: 30 },
  terminal: { w: 28, h: 26 }, crate: { w: 31, h: 31 }, pipe: { w: 60, h: 26 }, tank: { w: 52, h: 40 },
  crystal: { w: 60, h: 26 }, rock: { w: 50, h: 32 }, vent: { w: 47, h: 37 }, antenna: { w: 30, h: 27 },
  solar: { w: 76, h: 36 }, dish: { w: 40, h: 33 }, buoy: { w: 30, h: 20 }, reeds: null, bridge: null, circuit: null,
});

function boundaryOf(world: WorldConfig) {
  let boundary = boundaryCache.get(world);
  if (!boundary) { boundary = materialBoundary(world); boundaryCache.set(world, boundary); }
  return boundary;
}
function distanceToSegment([x, y]: XY, a: XY, b: XY) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
function circleIntersectsRect([x, y]: XY, radius: number, rect: WorldRect) {
  const nearX = Math.max(rect.x, Math.min(rect.x + rect.w, x));
  const nearY = Math.max(rect.y, Math.min(rect.y + rect.h, y));
  return Math.hypot(x - nearX, y - nearY) <= radius;
}

/** Collision uses a disk in world coordinates, including exact clearance from terrain edges. */
export function isWorldWalkable(world: WorldConfig, location: WorldPoint, radius = 0) {
  const config = validateWorld(world), position = point(location, "location", false);
  finite(radius, "radius", 0, 48);
  if (!containsLoaded(config, position)) return false;
  if (radius && boundaryOf(config).some(([a, b]) => distanceToSegment(position, a, b) < radius)) return false;
  const blocked: WorldRect[] = [...(config.collision?.blocked ?? []), ...config.patches.filter(patch => patch.pattern === "water")];
  for (const prop of config.props) {
    const size = PROP_FOOTPRINTS[prop.type];
    const scale = prop.scale ?? 1;
    const relative = prop.footprint === undefined ? size && {
      x: -size.w * 1.4 / PROJECTION.scale / 2, y: -size.h * 1.4 / PROJECTION.scale / 2,
      w: size.w * 1.4 / PROJECTION.scale, h: size.h * 1.4 / PROJECTION.scale,
    } : prop.footprint;
    if (relative) blocked.push({ x: prop.x + relative.x * scale, y: prop.y + relative.y * scale, w: relative.w * scale, h: relative.h * scale });
  }
  return !blocked.some(rect => circleIntersectsRect(position, radius, rect));
}

/** Stable painter's order. Put static layers and dynamic actors in the same list. */
export function sortWorldItems<T extends Readonly<{ x: number; y: number }>>(items: readonly T[]): T[] {
  for (const item of items) { finite(item.x, "item.x"); finite(item.y, "item.y"); }
  return [...items].sort((a, b) => (a.x + a.y) - (b.x + b.y));
}

function renderOptions(options: WorldRenderOptions) {
  record(options, "render options");
  if (options.signals !== undefined && typeof options.signals !== "boolean") throw new TypeError("signals must be a boolean.");
  const color = colorOption(options);
  const background = options.background ?? "transparent";
  choice(background, ["transparent", "black"], "background");
  return { signals: options.signals !== false, background, color };
}
function colorOption(options: PropRenderOptions) {
  record(options, "render options");
  if (options.color !== undefined && typeof options.color !== "boolean") throw new TypeError("color must be a boolean.");
  return options.color === true;
}
const projectPoint = ([x, y]: XY) => project(x, y);

function terrainParts(world: WorldConfig, color = false) {
  const id = `rf-${world.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const boundary = boundaryOf(world), depth = world.geometry.depth;
  const screenPolys = world.geometry.polygons.map(p => p.map(projectPoint));
  const holes = [...world.geometry.holes, ...world.missingChunks.map(rectPoly)].map(p => p.map(projectPoint));
  const mask = `<mask id="${id}-surface" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1200"><rect width="1600" height="1200" fill="#000"/>${screenPolys.map(p => polygon(p, 'fill="#fff"')).join('')}${holes.map(p => polygon(p, 'fill="#000"')).join('')}</mask>`;
  let body = `<g id="${id}-terrain" class="world-terrain">`;
  const visible = boundary.map(([a, b]) => [projectPoint(a), projectPoint(b)]).filter(([a, b]) => b[0] < a[0] - 0.001)
    .sort((a, b) => (a[0][1] + a[1][1]) - (b[0][1] + b[1][1]));
  for (const [a, b] of visible) {
    body += polygon([a, b, [b[0], b[1] + depth], [a[0], a[1] + depth]], `fill="${color ? GAME_PALETTE.coral : '#000'}" stroke="${color ? '#000' : '#fff'}" stroke-width="1.5" stroke-linejoin="miter"`);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let j = 24; j < length - 10; j += 55) {
      const t = j / length, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      body += `<path d="M${n(x)} ${n(y + depth - 5)}v4" stroke="#fff" stroke-width="1"/>`;
    }
  }
  body += `<g mask="url(#${id}-surface)"><rect width="1600" height="1200" fill="${color ? GAME_PALETTE.meadow : '#fff'}"/><g transform="${planeMatrix()}"><rect x="-100" y="-100" width="800" height="650" fill="url(#${id}-grid)"/>`;
  for (const patch of world.patches) body += `<rect x="${patch.x}" y="${patch.y}" width="${patch.w}" height="${patch.h}" fill="url(#${id}-${patch.pattern})" stroke="#000" stroke-width="1"/>`;
  for (const path of world.paths) {
    body += line(path.points, `stroke="#000" stroke-width="${path.width + 2}" stroke-linejoin="miter"`);
    body += line(path.points, `stroke="url(#${id}-dither)" stroke-width="${path.width}" stroke-linejoin="miter"`);
  }
  body += '</g></g>';
  for (const edge of boundary) body += line(edge.map(projectPoint), 'stroke="#000" stroke-width="2"');
  body += `</g><g class="world-loading">${world.missingChunks.map((chunk, index) => chunkArtwork(chunk, index, id, color)).join('')}</g>`;
  return { id, defs: definitions(id, color) + mask, body };
}

function svgDocument(world: WorldConfig, id: string, defs: string, body: string, background: "transparent" | "black" = "transparent") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200" role="img" aria-labelledby="${id}-title ${id}-desc" data-world-id="${esc(world.id)}" data-variant="${world.variant}"><title id="${id}-title">${esc(world.name)}</title><desc id="${id}-desc">${esc(world.summary)}. Rare Friends shallow isometric world. Character pixels, when present, are supplied by the caller.</desc><defs>${defs}</defs>${background === "black" ? '<rect width="1600" height="1200" fill="#000"/>' : ''}${body}</svg>\n`;
}

function objectParts(world: WorldConfig, id: string, signals: boolean, color = false) {
  return sortWorldItems([
    ...world.props.map(prop => {
      const [x, y] = project(prop.x, prop.y);
      return { kind: "prop" as const, x: prop.x, y: prop.y, depth: prop.x + prop.y,
        body: `<g class="world-prop" data-prop="${prop.type}" transform="translate(${x} ${y}) scale(${n((prop.scale ?? 1) * 1.4)})">${paintedPropArtwork(prop.type, id, color)}</g>` };
    }),
    ...(signals ? world.signals.map(signal => ({ kind: "signal" as const, x: signal.x, y: signal.y,
      depth: signal.x + signal.y, body: signalArtwork(signal, color) })) : []),
  ]);
}

/** Full-canvas static layers. Decode them once, then interleave upright live actors by x + y. */
export function renderWorldLayers(world: WorldConfig, options: Omit<WorldRenderOptions, "actors"> = {}): WorldLayers {
  const config = validateWorld(world), settings = renderOptions(options);
  const terrain = terrainParts(config, settings.color);
  return Object.freeze({ width: CANVAS.width, height: CANVAS.height,
    terrainSvg: svgDocument(config, terrain.id, terrain.defs, terrain.body, settings.background),
    objects: Object.freeze(objectParts(config, terrain.id, settings.signals, settings.color).map(({ body, ...item }) => Object.freeze({ ...item,
      svg: svgDocument(config, terrain.id, definitions(terrain.id, settings.color), body),
    }))),
  });
}

function actorArtwork(actor: WorldActor, world: WorldConfig) {
  const position = anchor(actor, "live actor");
  if (!containsLoaded(world, [position.x, position.y])) throw new RangeError("Live actor must be anchored on loaded ground.");
  if (!Array.isArray(actor.rows) || actor.rows.length !== 16 || actor.rows.some(row => typeof row !== "string" || !/^[.#]{16}$/.test(row))) {
    throw new TypeError("Live actor rows must contain exactly 16 rows of 16 '.' or '#' pixels.");
  }
  const scale = actor.pixelScale ?? 5;
  finite(scale, "actor.pixelScale", 1, 8);
  if (!Number.isInteger(scale)) throw new TypeError("Actor pixel scale must be an integer.");
  const identity = actor.id === undefined ? "" : text(actor.id, "actor.id", 100);
  const halo = Array.from({ length: 16 }, () => Array<string>(16).fill('.'));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (actor.rows[y][x] === '#') {
    for (let yy = Math.max(0, y - 1); yy <= Math.min(15, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(15, x + 1); xx++) halo[yy][xx] = '#';
  }
  function runs(rows: readonly (readonly string[] | string)[], fill: string) {
    let output = '';
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (rows[y][x] === '#') {
      const start = x;
      while (x + 1 < 16 && rows[y][x + 1] === '#') x++;
      output += `<rect x="${start * scale}" y="${y * scale}" width="${(x - start + 1) * scale}" height="${scale}"/>`;
    }
    return `<g fill="${fill}">${output}</g>`;
  }
  const [px, py] = project(position.x, position.y);
  return `<g class="world-actors" data-actor="${esc(identity)}" shape-rendering="crispEdges" transform="translate(${Math.round(px) - 8 * scale} ${Math.round(py) - 15 * scale})">${runs(halo, '#fff')}${runs(actor.rows, '#000')}</g>`;
}

/** Self-contained vector world export, optionally populated with current caller-supplied frames. */
export function renderWorld(world: WorldConfig, options: WorldRenderOptions = {}) {
  const config = validateWorld(world), settings = renderOptions(options), terrain = terrainParts(config, settings.color);
  const actors = array(options.actors, "live actors").map((value, index) => {
    const actor = record(value, `live actors[${index}]`) as unknown as WorldActor;
    return { ...anchor(actor, `live actors[${index}]`), body: actorArtwork(actor, config) };
  });
  const objects = sortWorldItems([...objectParts(config, terrain.id, settings.signals, settings.color), ...actors]);
  return svgDocument(config, terrain.id, terrain.defs, `${terrain.body}<g class="world-objects">${objects.map(item => item.body).join('')}</g>`, settings.background);
}

/** Reusable canonical prop fragment. Use renderProp for a complete standalone SVG. */
export function propArtwork(type: WorldPropType, id = "rf-prop", options: PropRenderOptions = {}) {
  choice(type, PROP_TYPES, "prop type");
  if (typeof id !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(id)) throw new TypeError("Prop definition ID must be an SVG identifier.");
  return paintedPropArtwork(type, id, colorOption(options));
}

/** Native-scale transparent asset; ground anchor is PROP_CANVAS.anchorX/anchorY. */
export function renderProp(type: WorldPropType, options: PropRenderOptions = {}) {
  const id = `rf-prop-${choice(type, PROP_TYPES, "prop type")}`;
  const color = colorOption(options);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="-120 -180 240 240" role="img" aria-label="${type}" data-anchor-x="120" data-anchor-y="180"><defs>${definitions(id, color)}</defs>${paintedPropArtwork(type, id, color)}</svg>\n`;
}

export const WORLD_PRESETS: readonly WorldConfig[] = Object.freeze(collection.worlds.map(validateWorld));

/** Returns an immutable validated scene; copy with structuredClone before editing. */
export function getWorldPreset(id: string): WorldConfig {
  const world = WORLD_PRESETS.find(candidate => candidate.id === id);
  if (!world) throw new RangeError(`Unknown world preset: ${id}.`);
  return world;
}
