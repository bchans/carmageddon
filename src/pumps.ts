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
const PIPE_COLOR = 0x3b7d9a;
const PIPE_RADIUS = 0.16;
// How many straight segments a pump-to-pump pipe is sampled into — enough to
// visibly follow the terrain's contour over a long uphill run without being
// expensive to build.
const PIPE_SEGMENTS = 16;

function buildPumpMesh(yaw: number): THREE.Object3D {
  const group = new THREE.Group();

  const housingMat = new THREE.MeshStandardMaterial({ color: HOUSING_COLOR, roughness: 0.6, metalness: 0.35 });
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 1.3, 12), housingMat);
  housing.position.y = 0.65;
  housing.castShadow = true;
  housing.receiveShadow = true;
  group.add(housing);

  // A stubby arm pointing towards whichever neighbor this pump connects to
  // (the water it draws from, for an intake; the linked intake, for an
  // outlet) — local +Z is "forward" here, rotated to face that direction.
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

  group.rotation.y = yaw;
  group.scale.setScalar(1.15);
  return group;
}

/** A pipe mesh tracing the ground between two pumps, so a source→outlet link
 * that runs a long way uphill reads as one continuous connection rather than
 * two unrelated basins. Sampled at terrain height plus a small rise rather
 * than a straight 3D line, so it visibly follows the slope in between. */
function buildPipe(terrain: Terrain, from: Cell, to: Cell): THREE.Object3D {
  const a = cellCenter(from);
  const b = cellCenter(to);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= PIPE_SEGMENTS; i++) {
    const t = i / PIPE_SEGMENTS;
    const x = THREE.MathUtils.lerp(a.x, b.x, t);
    const z = THREE.MathUtils.lerp(a.z, b.z, t);
    points.push(new THREE.Vector3(x, terrain.getHeightAt(x, z) + 0.3, z));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, PIPE_SEGMENTS, PIPE_RADIUS, 6, false);
  const material = new THREE.MeshStandardMaterial({ color: PIPE_COLOR, roughness: 0.4, metalness: 0.5 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Pumps come in linked pairs and are the one deliberate exception to "water
 * only flows downhill" (see WaterField's Pass 3): an *intake*, placed next
 * to existing water and auto-facing whichever adjacent cell is already wet
 * (like a ramp auto-faces the connection it's built from — no separate
 * rotate control), draws continuously from that neighbor into its own dug
 * basin. Placing a second pump anywhere else — the *outlet*, no adjacency
 * requirement — links the two: water is then relayed from the intake's
 * basin into the outlet's, wherever that is, uphill or not. Once it lands
 * there it's just ordinary depth on the ordinary grid, so it spreads,
 * pools, and drains back downhill exactly like natural water (see
 * WaterField's diffusion pass) — the pump only does the uphill lifting, not
 * anything downstream of that.
 *
 * Only one pair is ever "in progress" at a time: placing an intake leaves it
 * awaiting an outlet (see awaitingOutlet/cancelPending) before another
 * intake can be started.
 */
export class PumpSystem {
  private readonly terrain: Terrain;
  private readonly waterField: WaterField;
  private readonly isCellFree: (cell: Cell) => boolean;
  private readonly claimCell: (cell: Cell) => void;
  private readonly pumps = new Map<string, Cell>();
  /** An intake placed and waiting for its outlet — see place(). */
  private pendingIntake: Cell | null = null;
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

  /** Whether an intake is placed and waiting for its outlet — the next place() call completes the pair instead of starting a new one. */
  get awaitingOutlet(): boolean {
    return this.pendingIntake !== null;
  }

  canPlace(cell: Cell): boolean {
    if (Math.abs(cell.col * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE / 2) return false;
    if (Math.abs(cell.row * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE / 2) return false;
    if (this.pumps.has(cellKey(cell))) return false;
    if (!this.isCellFree(cell)) return false;
    const center = cellCenter(cell);
    if (this.terrain.isUnderwaterAt(center.x, center.z)) return false;
    // An outlet just needs a free, dry tile; an intake needs a wet neighbor to draw from.
    if (this.pendingIntake) return true;
    return this.sourceDirection(cell) !== null;
  }

  place(cell: Cell): boolean {
    if (!this.canPlace(cell)) return false;

    const center = cellCenter(cell);
    const basinHeight = this.terrain.getHeightAt(center.x, center.z) - PUMP_BASIN_DEPTH;
    this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, () => basinHeight);
    this.claimCell(cell);
    this.pumps.set(cellKey(cell), cell);

    if (this.pendingIntake) {
      const intakeCell = this.pendingIntake;
      this.waterField.registerPump(intakeCell, cell);

      const intakeCenter = cellCenter(intakeCell);
      const yaw = Math.atan2(intakeCenter.x - center.x, intakeCenter.z - center.z);
      const mesh = buildPumpMesh(yaw);
      mesh.position.set(center.x, basinHeight, center.z);
      this.root.add(mesh);
      this.root.add(buildPipe(this.terrain, intakeCell, cell));

      this.pendingIntake = null;
      return true;
    }

    const dir = this.sourceDirection(cell)!;
    const { dc, dr } = DIRS[dir];
    const sourceCell: Cell = { col: cell.col + dc, row: cell.row + dr };
    this.waterField.registerPump(sourceCell, cell);

    const mesh = buildPumpMesh(Math.atan2(dc, dr));
    mesh.position.set(center.x, basinHeight, center.z);
    this.root.add(mesh);

    this.pendingIntake = cell;
    return true;
  }

  /** Abandons an intake awaiting its outlet (e.g. the player switched tools) — the intake itself stays placed and keeps drawing from its water-adjacent neighbor, it just won't relay anywhere until a new pair is started. */
  cancelPending(): void {
    this.pendingIntake = null;
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
    return [...this.pumps.values()];
  }
}
