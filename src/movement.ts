import { createWorldNavigator } from "./friend-navigation.js";
import { isWorldWalkable, project, unproject, type WorldConfig, type WorldPoint } from "./friend-world.js";
import type { SpriteFacing } from "./generation-sprites.js";

const directions: Readonly<Record<string, SpriteFacing>> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
};
const vectors: Readonly<Record<SpriteFacing, WorldPoint>> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export type MovementState = Readonly<{
  position: WorldPoint; facing: SpriteFacing; walking: boolean; destination: WorldPoint | null;
}>;

/** Host owns DOM events and animation frames; movement stays in world coordinates. */
export function createWorldMovement(world: WorldConfig, spawn: WorldPoint, options: { speed?: number; radius?: number } = {}) {
  const speed = options.speed ?? 170, radius = options.radius ?? 7;
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Movement speed must be positive.");
  const navigation = createWorldNavigator(world, radius);
  if (!isWorldWalkable(world, spawn, radius)) throw new RangeError("Spawn must be walkable.");
  let position: WorldPoint = [...spawn], facing: SpriteFacing = "down", walking = false;
  let route: WorldPoint[] = [];
  const held = new Map<string, SpriteFacing>();
  const state = (): MovementState => ({ position: [...position], facing, walking,
    destination: route.length ? [...route[route.length - 1]] : null });
  const stop = () => { held.clear(); route = []; walking = false; };

  return {
    get state() { return state(); },
    /** Returns whether a key is handled. Clear held keys with stop() on blur/pause. */
    setKey(key: string, pressed: boolean) {
      const normalized = key.length === 1 ? key.toLowerCase() : key;
      const direction = directions[normalized];
      if (!direction) return false;
      if (pressed) { route = []; held.set(normalized, direction); }
      else held.delete(normalized);
      return true;
    },
    moveTo(point: WorldPoint) {
      const path = navigation.route(position, point);
      if (!path) return false;
      stop(); route = path;
      return true;
    },
    stop,
    reset() { stop(); position = [...spawn]; facing = "down"; },
    /** Delta is milliseconds; a suspended tab advances by at most 40 ms. */
    update(deltaMs: number): MovementState {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError("Frame delta must be nonnegative.");
      walking = false;
      const [sx, sy] = project(...position);
      let dx = 0, dy = 0, step = Math.min(40, deltaMs) * speed / 1000;
      const inputs = [...new Set(held.values())];
      if (inputs.length) {
        for (const direction of inputs) { dx += vectors[direction][0]; dy += vectors[direction][1]; }
        const magnitude = Math.hypot(dx, dy);
        if (magnitude) {
          dx /= magnitude; dy /= magnitude;
          facing = [...inputs].reverse().find(direction => vectors[direction][0] * dx + vectors[direction][1] * dy > 0)!;
        }
      } else if (route.length) {
        // Consume already reached waypoints without an idle frame between segments.
        while (route.length && Math.hypot(route[0][0] - position[0], route[0][1] - position[1]) < 0.001) position = route.shift()!;
        if (route.length) {
          const [tx, ty] = project(...route[0]);
          const distance = Math.hypot(tx - sx, ty - sy);
          dx = (tx - sx) / distance; dy = (ty - sy) / distance;
          step = Math.min(step, distance);
          facing = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "up" : "down";
        }
      }
      if (step > 0 && (dx || dy)) {
        const next = unproject(sx + dx * step, sy + dy * step);
        if (navigation.segmentClear(position, next)) { position = next; walking = true; }
        else if (route.length) stop();
        else if (dx && dy) {
          const slide = [unproject(sx + dx * step, sy), unproject(sx, sy + dy * step)]
            .find(point => navigation.segmentClear(position, point));
          if (slide) { position = slide; walking = true; }
        }
        // SVG projection rounds to 0.001 px; absorb that error at each waypoint.
        if (route.length && Math.hypot(route[0][0] - position[0], route[0][1] - position[1]) < 0.001) {
          position = route.shift()!;
        }
      }
      return state();
    },
  };
}
