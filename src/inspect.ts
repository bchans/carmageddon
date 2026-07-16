import type { Game } from "./game";
import { cellCenter, cellKey, DIRS, type Cell } from "./network";

// A console diagnostic dump, not a UI — meant to be called from DevTools
// (see main.ts for the window.__inspect / __inspectHover globals) and its
// output copy-pasted straight into chat when reporting a terrain-clipping,
// water-not-flowing, or similar per-tile bug. Reaches into Game/TileNetwork
// internals via bracket access since none of this needs to be a public API
// surface — it's a debugging tool, not part of the game itself.

const DIR_NAMES = ["N", "E", "S", "W"];

function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function tileSummary(net: unknown, cell: Cell): unknown {
  const n = net as { ["tiles"]?: Map<string, { kind: string; centerHeight: number; facing: number; slope: unknown }> };
  const tile = n["tiles"]?.get(cellKey(cell));
  if (!tile) return null;
  const slope = tile.slope as { axisIsZ: boolean; loHeight: number; hiHeight: number } | null;
  return {
    kind: tile.kind,
    centerHeight: round(tile.centerHeight),
    facing: tile.facing,
    slope: slope ? { axisIsZ: slope.axisIsZ, loHeight: round(slope.loHeight), hiHeight: round(slope.hiHeight) } : null,
  };
}

function edgeHeight(net: unknown, cell: Cell, dir: number): number | null {
  const n = net as { edgeHeightTowards?: (cell: Cell, dir: number) => number | null };
  if (typeof n.edgeHeightTowards !== "function") return null;
  const h = n.edgeHeightTowards(cell, dir);
  return h === null ? null : round(h);
}

/**
 * Full diagnostic dump for one grid cell: terrain height (current, slope,
 * underwater-at-generation), the live water field (depth/navigable/surface
 * height), and — for every transport network — whether a tile is placed
 * there and its graded bed/slope, plus the same for all 4 neighbors
 * (including each network's edge-facing height, so an artificial "cliff"
 * between two adjacent tiles shows up directly in the dump instead of
 * requiring a follow-up question).
 */
export function inspectCell(game: Game, cell: Cell): Record<string, unknown> {
  const g = game as unknown as Record<string, unknown>;
  const terrain = g.terrain as { getHeightAt: (x: number, z: number) => number; getSlopeAt: (x: number, z: number) => number; isUnderwaterAt: (x: number, z: number) => boolean };
  const waterField = g.waterField as { depthAt: (x: number, z: number) => number; isNavigable: (x: number, z: number) => boolean; surfaceHeightAt: (x: number, z: number) => number };
  const center = cellCenter(cell);

  const networks: Array<[string, unknown]> = [
    ["road", g.roads],
    ["track", g.tracks],
    ["canal", g.canals],
  ];

  const networkInfo: Record<string, unknown> = {};
  for (const [name, net] of networks) networkInfo[name] = tileSummary(net, cell);

  const neighbors: Record<string, unknown> = {};
  DIRS.forEach(({ dc, dr }, dir) => {
    const nCell = { col: cell.col + dc, row: cell.row + dr };
    const nCenter = cellCenter(nCell);
    const entry: Record<string, unknown> = {
      cell: nCell,
      terrainHeight: round(terrain.getHeightAt(nCenter.x, nCenter.z)),
      waterDepth: round(waterField.depthAt(nCenter.x, nCenter.z)),
    };
    for (const [name, net] of networks) {
      const nTile = tileSummary(net, nCell) as { centerHeight: number } | null;
      entry[`${name}Bed`] = nTile ? nTile.centerHeight : null;
      entry[`${name}EdgeFromHere`] = edgeHeight(net, cell, dir);
      entry[`${name}EdgeFromThere`] = edgeHeight(net, nCell, (dir + 2) % 4);
    }
    neighbors[DIR_NAMES[dir]] = entry;
  });

  return {
    cell,
    world: { x: round(center.x), z: round(center.z) },
    terrain: {
      height: round(terrain.getHeightAt(center.x, center.z)),
      slope: round(terrain.getSlopeAt(center.x, center.z)),
      isUnderwaterAt: terrain.isUnderwaterAt(center.x, center.z),
    },
    water: {
      depth: round(waterField.depthAt(center.x, center.z)),
      isNavigable: waterField.isNavigable(center.x, center.z),
      surfaceHeight: round(waterField.surfaceHeightAt(center.x, center.z)),
    },
    networks: networkInfo,
    neighbors,
  };
}

export function inspectCells(game: Game, cells: Cell[]): Record<string, unknown>[] {
  return cells.map((c) => inspectCell(game, c));
}
