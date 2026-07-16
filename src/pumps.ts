import * as THREE from "three";
import type { Terrain } from "./terrain";
import type { WaterField } from "./waterField";
import { DIRS, TILE_SIZE, cellCenter, cellKey, type Cell } from "./network";

// How deep a pump digs its own basin on placement — shallow (it's meant to
// hold whatever the pump feeds it, not to be a reservoir on its own; the
// player can deepen it further with the canal dig tool afterward if they
// want a bigger artificial lake to spread into).
const PUMP_BASIN_DEPTH = 0.6;

const HOUSING_COLOR = 0x8a6d3b;
const ARM_COLOR = 0x3b7d9a;

function buildPumpMesh(dir: number): THREE.Object3D {
  const group = new THREE.Group();

  const housingMat = new THREE.MeshStandardMaterial({ color: HOUSING_COLOR, roughness: 0.6, metalness: 0.35 });
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 1.3, 12), housingMat);
  housing.position.y = 0.65;
  housing.castShadow = true;
  housing.receiveShadow = true;
  group.add(housing);

  // A stubby intake arm pointing towards whichever neighbor the pump draws
  // from — local +Z is "forward" here, rotated to face DIRS[dir] in world
  // space (dc, dr) via yaw = atan2(dc, dr).
  const armMat = new THREE.MeshStandardMaterial({ color: ARM_COLOR, roughness: 0.4, metalness: 0.55 });
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.7, 8), armMat);
  arm.rotation.x = Math.PI / 2;
  arm.position.set(0, 0.85, 0.85);
  arm.castShadow = true;
  group.add(arm);

  const tipMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.3, metalness: 0.6 });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.5, 8), tipMat);
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0, 0.85, 1.65);
  tip.castShadow = true;
  group.add(tip);

  const { dc, dr } = DIRS[dir];
  group.rotation.y = Math.atan2(dc, dr);
  group.scale.setScalar(1.15);
  return group;
}

/**
 * A pump lifts water uphill — the one deliberate exception to "water only
 * flows downhill" (see WaterField's Pass 3). Placed on a dug basin at its
 * own cell, auto-facing whichever adjacent cell is already wet at
 * placement time (like a ramp auto-faces the connection it's built from —
 * no separate rotate control), and continuously pulls from that neighbor
 * into itself for as long as the neighbor stays wet.
 */
export class PumpSystem {
  private readonly terrain: Terrain;
  private readonly waterField: WaterField;
  private readonly isCellFree: (cell: Cell) => boolean;
  private readonly claimCell: (cell: Cell) => void;
  private readonly pumps = new Map<string, { cell: Cell; dir: number }>();
  readonly root = new THREE.Group();

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

  /** Direction (index into DIRS) of the first adjacent cell that's currently wet, or null if none. */
  private sourceDirection(cell: Cell): number | null {
    for (let dir = 0; dir < DIRS.length; dir++) {
      const { dc, dr } = DIRS[dir];
      const c = cellCenter({ col: cell.col + dc, row: cell.row + dr });
      if (this.waterField.isNavigable(c.x, c.z)) return dir;
    }
    return null;
  }

  canPlace(cell: Cell): boolean {
    if (Math.abs(cell.col * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE / 2) return false;
    if (Math.abs(cell.row * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE / 2) return false;
    if (this.pumps.has(cellKey(cell))) return false;
    if (!this.isCellFree(cell)) return false;
    const center = cellCenter(cell);
    if (this.terrain.isUnderwaterAt(center.x, center.z)) return false;
    return this.sourceDirection(cell) !== null;
  }

  place(cell: Cell): boolean {
    if (!this.canPlace(cell)) return false;
    const dir = this.sourceDirection(cell);
    if (dir === null) return false;

    const center = cellCenter(cell);
    const basinHeight = this.terrain.getHeightAt(center.x, center.z) - PUMP_BASIN_DEPTH;
    this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, () => basinHeight);
    this.claimCell(cell);

    const { dc, dr } = DIRS[dir];
    const sourceCell: Cell = { col: cell.col + dc, row: cell.row + dr };
    this.waterField.registerPump(sourceCell, cell);
    this.pumps.set(cellKey(cell), { cell, dir });

    const mesh = buildPumpMesh(dir);
    mesh.position.copy(center);
    mesh.position.y = basinHeight;
    this.root.add(mesh);
    return true;
  }

  cellWorldCenter(cell: Cell): THREE.Vector3 {
    const c = cellCenter(cell);
    c.y = this.terrain.getHeightAt(c.x, c.z);
    return c;
  }

  get tileCount(): number {
    return this.pumps.size;
  }

  get occupiedCells(): Cell[] {
    return [...this.pumps.values()].map((p) => p.cell);
  }
}
