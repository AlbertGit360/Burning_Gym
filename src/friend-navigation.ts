import { isWorldWalkable, type WorldConfig, type WorldPoint } from "./friend-world.js";

/** A small, local navigation grid. Every traversed and simplified segment is collision checked. */
export function createWorldNavigator(world: WorldConfig, radius = 7, spacing = 8) {
  if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(spacing) || spacing < 2 || spacing > 32) {
    throw new RangeError("Navigation needs a nonnegative radius and a grid spacing from 2 to 32.");
  }
  const columns = Math.floor(576 / spacing) + 1;
  const rows = Math.floor(384 / spacing) + 1;
  const count = columns * rows;
  const valid = new Uint8Array(count);
  const location = (index: number): WorldPoint => [(index % columns) * spacing, Math.floor(index / columns) * spacing];
  const finite = (point: WorldPoint) => point.every(Number.isFinite);
  const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (let index = 0; index < count; index++) valid[index] = Number(isWorldWalkable(world, location(index), radius));

  function segmentClear(from: WorldPoint, to: WorldPoint) {
    if (!finite(from) || !finite(to)) return false;
    const length = distance(from, to);
    if (length > 1200) return false;
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let index = 0; index <= steps; index++) {
      const t = index / steps;
      if (!isWorldWalkable(world, [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], radius)) return false;
    }
    return true;
  }

  function nearby(point: WorldPoint) {
    const centerX = Math.round(point[0] / spacing), centerY = Math.round(point[1] / spacing);
    const result: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = centerX + dx, y = centerY + dy;
      if (x < 0 || y < 0 || x >= columns || y >= rows) continue;
      const index = y * columns + x;
      if (valid[index] && segmentClear(point, location(index))) result.push(index);
    }
    return result;
  }

  function route(from: WorldPoint, to: WorldPoint): WorldPoint[] | null {
    if (!finite(from) || !finite(to) || !isWorldWalkable(world, from, radius) || !isWorldWalkable(world, to, radius)) return null;
    if (segmentClear(from, to)) return [[to[0], to[1]]];
    const starts = nearby(from), ends = new Set(nearby(to));
    if (!starts.length || !ends.size) return null;
    const parents = new Int32Array(count).fill(-1);
    const costs = new Float64Array(count).fill(Infinity);
    const closed = new Uint8Array(count);
    const open = new Set<number>(starts);
    for (const index of starts) costs[index] = distance(from, location(index));
    let reached = -1;
    while (open.size) {
      let current = -1, best = Infinity;
      for (const candidate of open) {
        const score = costs[candidate] + distance(location(candidate), to);
        if (score < best) { current = candidate; best = score; }
      }
      if (current < 0) break;
      if (ends.has(current)) { reached = current; break; }
      open.delete(current); closed[current] = 1;
      const x = current % columns, y = Math.floor(current / columns);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue;
        const neighbor = (y + dy) * columns + x + dx;
        if (!valid[neighbor] || closed[neighbor]) continue;
        const nextCost = costs[current] + spacing * Math.hypot(dx, dy);
        if (nextCost >= costs[neighbor] || !segmentClear(location(current), location(neighbor))) continue;
        costs[neighbor] = nextCost; parents[neighbor] = current; open.add(neighbor);
      }
    }
    if (reached < 0) return null;
    const path: WorldPoint[] = [[to[0], to[1]]];
    for (let index = reached; index !== -1; index = parents[index]) path.unshift(location(index));
    const simplified: WorldPoint[] = [];
    let anchor = from;
    for (let index = 0; index < path.length;) {
      let last = path.length - 1;
      while (last > index && !segmentClear(anchor, path[last])) last--;
      simplified.push(path[last]); anchor = path[last]; index = last + 1;
    }
    return simplified;
  }

  return { route, segmentClear };
}
