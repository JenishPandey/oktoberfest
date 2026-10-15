import * as THREE from "three";
import { ARENA_HALF } from "./world.js";

// Grid A* pathfinding. Game owns movement; LLM only gives high-level targets.
const CELL = 1.5;
const N = Math.ceil((ARENA_HALF * 2) / CELL); // ~35

let blocked = null; // 2D bool array

export function buildNavGrid(colliders) {
  blocked = new Array(N * N).fill(false);
  for (let ix = 0; ix < N; ix++) {
    for (let iz = 0; iz < N; iz++) {
      const wx = -ARENA_HALF + (ix + 0.5) * CELL;
      const wz = -ARENA_HALF + (iz + 0.5) * CELL;
      for (const c of colliders) {
        // inflate by 0.5 so agents don't clip corners
        if (wx > c.min.x - 0.5 && wx < c.max.x + 0.5 && wz > c.min.z - 0.5 && wz < c.max.z + 0.5) {
          blocked[iz * N + ix] = true;
          break;
        }
      }
    }
  }
}

export function worldToCell(v) {
  const ix = Math.max(0, Math.min(N - 1, Math.floor((v.x + ARENA_HALF) / CELL)));
  const iz = Math.max(0, Math.min(N - 1, Math.floor((v.z + ARENA_HALF) / CELL)));
  return { ix, iz };
}

export function cellToWorld(ix, iz) {
  return new THREE.Vector3(-ARENA_HALF + (ix + 0.5) * CELL, 0, -ARENA_HALF + (iz + 0.5) * CELL);
}

function nearestFree(ix, iz) {
  if (!blocked) return { ix, iz };
  if (!blocked[iz * N + ix]) return { ix, iz };
  for (let r = 1; r < 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        if (!blocked[nz * N + nx]) return { ix: nx, iz: nz };
      }
    }
  }
  return { ix, iz };
}

export function findPath(startV, endV) {
  if (!blocked) return [endV.clone()];
  let s = nearestFree(...Object.values(worldToCell(startV)));
  let e = nearestFree(...Object.values(worldToCell(endV)));
  const sIdx = s.iz * N + s.ix, eIdx = e.iz * N + e.ix;
  if (sIdx === eIdx) return [endV.clone()];

  const open = [{ idx: sIdx, f: 0 }];
  const came = new Map();
  const g = new Map([[sIdx, 0]]);
  const h = (i) => {
    const ix = i % N, iz = Math.floor(i / N);
    return Math.abs(ix - e.ix) + Math.abs(iz - e.iz);
  };
  const closed = new Set();

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift().idx;
    if (cur === eIdx) {
      const cells = [];
      let c = cur;
      while (c !== undefined && c !== sIdx) { cells.push(c); c = came.get(c); }
      cells.reverse();
      return cells.map((ci) => cellToWorld(ci % N, Math.floor(ci / N)));
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % N, cz = Math.floor(cur / N);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const ni = nz * N + nx;
        if (blocked[ni] || closed.has(ni)) continue;
        const cost = (dx && dz) ? 1.414 : 1;
        const ng = (g.get(cur) ?? Infinity) + cost;
        if (ng < (g.get(ni) ?? Infinity)) {
          g.set(ni, ng);
          came.set(ni, cur);
          open.push({ idx: ni, f: ng + h(ni) });
        }
      }
    }
    if (closed.size > 3000) break;
  }
  return [endV.clone()]; // fallback: straight line
}
