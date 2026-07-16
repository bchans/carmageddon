import type { Terrain } from "./terrain";
import type { WaterField } from "./waterField";
import { TILE_SIZE, cellCenter, cellKey, worldToCell, type Cell, type Waypoint } from "./network";
import * as THREE from "three";

// How much a single dig application lowers a cell's bed, relative to that
// cell's own original (pre-dig) terrain height — not an absolute floor, so
// digging works the same way regardless of the local terrain's elevation.
// Repeatable (see dig() below): one application is usually enough near sea
// level, several deepen a pit dug into higher ground or meant to hold a
// deeper artificial lake.
export const CANAL_DIG_STEP = 0.8;
// Caps how many times the same cell can be dug, so a player can't spam it
// into an absurd bottomless pit.
export const CANAL_MAX_DIG_LEVEL = 6;

/**
 * A canal is nothing but a repeatable dig tool now — placing one just
 * carves a trench into the terrain (targetHeight below); there is no
 * "canal tile" shape, network, or visual marker of its own. Whether the
 * trench ever holds water, and whether a ship can sail through it, is
 * entirely up to WaterField (flow) and its own findPath (routing through
 * whatever's currently wet) — this class only ever touches the ground.
 */
export class CanalSystem {
  private readonly terrain: Terrain;
  private readonly waterField: WaterField;
  private readonly isCellFree: (cell: Cell) => boolean;
  private readonly claimCell: (cell: Cell) => void;
  private readonly dug = new Map<string, { cell: Cell; level: number; origin: number }>();
  private spawnCell: Cell = { col: 0, row: 0 };
  private targetCell: Cell = { col: 0, row: 0 };

  constructor(
    terrain: Terrain,
    waterField: WaterField,
    isCellFree: (cell: Cell) => boolean,
    claimCell: (cell: Cell) => void,
  ) {
    this.terrain = terrain;
    this.waterField = waterField;
    this.isCellFree = isCellFree;
    this.claimCell = claimCell;
  }

  setEndpoints(spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): void {
    this.spawnCell = worldToCell(spawnWorld.x, spawnWorld.z);
    this.targetCell = worldToCell(targetWorld.x, targetWorld.z);
  }

  canDig(cell: Cell): boolean {
    if (Math.abs(cell.col * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE / 2) return false;
    if (Math.abs(cell.row * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE / 2) return false;
    if (!this.isCellFree(cell)) return false;
    const existing = this.dug.get(cellKey(cell));
    if (existing && existing.level >= CANAL_MAX_DIG_LEVEL) return false;
    if (!existing) {
      const center = cellCenter(cell);
      // Never dig directly into a already-natural lake/river/ocean cell —
      // it's already a waterway on its own; see WaterField's isNavigable.
      if (this.terrain.isUnderwaterAt(center.x, center.z)) return false;
    }
    return true;
  }

  /** Digs (or re-digs, deepening it further) the bed at `cell`. Returns false if canDig() would've refused. */
  dig(cell: Cell): boolean {
    if (!this.canDig(cell)) return false;
    const key = cellKey(cell);
    const center = cellCenter(cell);
    let entry = this.dug.get(key);
    if (!entry) {
      entry = { cell, level: 0, origin: this.terrain.getHeightAt(center.x, center.z) };
      this.dug.set(key, entry);
      this.claimCell(cell);
    }
    entry.level += 1;
    const targetHeight = entry.origin - entry.level * CANAL_DIG_STEP;
    this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, () => targetHeight);
    return true;
  }

  digLevelAt(cell: Cell): number {
    return this.dug.get(cellKey(cell))?.level ?? 0;
  }

  get tileCount(): number {
    return this.dug.size;
  }

  get occupiedCells(): Cell[] {
    return [...this.dug.values()].map((d) => d.cell);
  }

  /** Dry-ground world center of `cell`, for the hover marker — matches every other network's convention (a not-yet-dug tile still highlights sensibly). */
  cellWorldCenter(cell: Cell): THREE.Vector3 {
    const c = cellCenter(cell);
    c.y = this.terrain.getHeightAt(c.x, c.z);
    return c;
  }

  /** Routes purely through currently-navigable water — see WaterField.findPath. */
  findPath(): Cell[] | null {
    return this.waterField.findPath(this.spawnCell, this.targetCell);
  }

  buildWaypoints(path: Cell[], spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): Waypoint[] {
    const points: Waypoint[] = [];
    for (let i = 0; i < path.length; i++) {
      if (i === 0) {
        points.push({ position: spawnWorld.clone(), slow: false });
        continue;
      }
      if (i === path.length - 1) {
        points.push({ position: targetWorld.clone(), slow: false });
        continue;
      }
      points.push({ position: cellCenter(path[i]), slow: false });
    }
    return points;
  }
}
