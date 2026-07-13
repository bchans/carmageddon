import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";

export const TILE_SIZE = 4;
const CURB_HEIGHT = 0.6;
const CURB_THICKNESS = 0.25;
const SLAB_THICKNESS = 0.16;

export const RoadKind = {
  Standard: "standard",
  Crossroad: "crossroad",
  Ramp: "ramp",
  Boost: "boost",
  Mud: "mud",
} as const;
export type RoadKind = (typeof RoadKind)[keyof typeof RoadKind];

export const SPEED_MULTIPLIER: Record<RoadKind, number> = {
  [RoadKind.Standard]: 1,
  [RoadKind.Crossroad]: 1,
  [RoadKind.Ramp]: 1,
  [RoadKind.Boost]: 1.7,
  [RoadKind.Mud]: 0.45,
};

export interface Cell {
  col: number;
  row: number;
}

const DIRS: Array<{ dc: number; dr: number }> = [
  { dc: 0, dr: 1 }, // N
  { dc: 1, dr: 0 }, // E
  { dc: 0, dr: -1 }, // S
  { dc: -1, dr: 0 }, // W
];

function cellKey(c: Cell): string {
  return `${c.col}:${c.row}`;
}

class RoadTile {
  readonly cell: Cell;
  readonly kind: RoadKind;
  readonly group = new THREE.Group();
  private curbBodies: RAPIER.RigidBody[] = [];
  private readonly world: RAPIER.World;
  private readonly RAPIER: Rapier;
  private readonly centerHeight: number;
  /** For ramps: the direction (index into DIRS) the ramp launches towards. */
  readonly facing: number;

  constructor(RAPIER: Rapier, world: RAPIER.World, cell: Cell, kind: RoadKind, centerHeight: number, facing: number) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.cell = cell;
    this.kind = kind;
    this.centerHeight = centerHeight;
    this.facing = facing;
    this.group.add(buildSlabMesh(kind));
  }

  /** Rebuild the perpendicular curb walls based on which neighbor sides are open. */
  updateConnections(connectedMask: boolean[]): void {
    for (const body of this.curbBodies) this.world.removeRigidBody(body);
    this.curbBodies = [];

    if (this.kind === RoadKind.Crossroad) return; // always open in all directions

    const center = cellCenter(this.cell);
    for (let dir = 0; dir < 4; dir++) {
      if (connectedMask[dir]) continue;
      if (this.kind === RoadKind.Ramp && dir === this.facing) continue; // launch end stays open
      if (this.kind === RoadKind.Ramp && dir === (this.facing + 2) % 4) continue; // entry end stays open
      this.addCurb(dir, center);
    }
  }

  private addCurb(dir: number, center: THREE.Vector3): void {
    const { dc, dr } = DIRS[dir];
    const isNS = dc === 0;
    const hx = isNS ? TILE_SIZE / 2 : CURB_THICKNESS / 2;
    const hz = isNS ? CURB_THICKNESS / 2 : TILE_SIZE / 2;
    const x = center.x + (dc * TILE_SIZE) / 2;
    const z = center.z + (dr * TILE_SIZE) / 2;
    const y = this.centerHeight + SLAB_THICKNESS + CURB_HEIGHT / 2;

    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(hx, CURB_HEIGHT / 2, hz).setFriction(0.9);
    this.world.createCollider(colliderDesc, body);
    this.curbBodies.push(body);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, CURB_HEIGHT, hz * 2),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.8 }),
    );
    mesh.position.set(x - center.x, CURB_HEIGHT / 2 + SLAB_THICKNESS, z - center.z);
    mesh.castShadow = true;
    this.group.add(mesh);
  }
}

function cellCenter(cell: Cell): THREE.Vector3 {
  return new THREE.Vector3(cell.col * TILE_SIZE, 0, cell.row * TILE_SIZE);
}

function buildSlabMesh(kind: RoadKind): THREE.Mesh {
  const colors: Record<RoadKind, number> = {
    [RoadKind.Standard]: 0x3a3a3f,
    [RoadKind.Crossroad]: 0x45454b,
    [RoadKind.Ramp]: 0x55503f,
    [RoadKind.Boost]: 0xffa53d,
    [RoadKind.Mud]: 0x5b4632,
  };
  const geo = new THREE.BoxGeometry(TILE_SIZE * 0.96, SLAB_THICKNESS, TILE_SIZE * 0.96);
  const mat = new THREE.MeshStandardMaterial({ color: colors[kind], roughness: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SLAB_THICKNESS / 2;
  mesh.receiveShadow = true;
  return mesh;
}

export class RoadSystem {
  readonly root = new THREE.Group();
  private readonly tiles = new Map<string, RoadTile>();
  private readonly RAPIER: Rapier;
  private readonly world: RAPIER.World;
  private readonly terrain: Terrain;
  private spawnCell: Cell = { col: 0, row: 0 };
  private targetCell: Cell = { col: 0, row: 0 };

  constructor(RAPIER: Rapier, world: RAPIER.World, terrain: Terrain) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.terrain = terrain;
  }

  /**
   * Roads are permanent and persist across levels — only the spawn/target
   * network endpoints move each time a new toll run starts.
   */
  setEndpoints(spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): void {
    this.spawnCell = this.worldToCell(spawnWorld.x, spawnWorld.z);
    this.targetCell = this.worldToCell(targetWorld.x, targetWorld.z);
    for (const cell of [...this.tiles.keys()]) {
      const [col, row] = cell.split(":").map(Number);
      this.refreshCurbs({ col, row });
    }
  }

  worldToCell(x: number, z: number): Cell {
    return { col: Math.round(x / TILE_SIZE), row: Math.round(z / TILE_SIZE) };
  }

  cellWorldCenter(cell: Cell): THREE.Vector3 {
    const c = cellCenter(cell);
    c.y = this.terrain.getHeightAt(c.x, c.z);
    return c;
  }

  private isNetworkCell(cell: Cell): boolean {
    if (cell.col === this.spawnCell.col && cell.row === this.spawnCell.row) return true;
    if (cell.col === this.targetCell.col && cell.row === this.targetCell.row) return true;
    return this.tiles.has(cellKey(cell));
  }

  private connectionMask(cell: Cell): boolean[] {
    return DIRS.map(({ dc, dr }) => this.isNetworkCell({ col: cell.col + dc, row: cell.row + dr }));
  }

  /** Which direction (if any) an adjacent network cell lies, for auto-orienting new tiles. */
  private incomingDirection(cell: Cell): number | null {
    for (let dir = 0; dir < 4; dir++) {
      const { dc, dr } = DIRS[dir];
      if (this.isNetworkCell({ col: cell.col + dc, row: cell.row + dr })) return dir;
    }
    return null;
  }

  canPlace(cell: Cell): boolean {
    if (this.isNetworkCell(cell)) return false;
    if (Math.abs(cell.col * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE) return false;
    if (Math.abs(cell.row * TILE_SIZE) > this.terrain.worldSize / 2 - TILE_SIZE) return false;
    return this.incomingDirection(cell) !== null;
  }

  place(cell: Cell, kind: RoadKind): boolean {
    if (!this.canPlace(cell)) return false;
    const incoming = this.incomingDirection(cell)!;
    const facing = (incoming + 2) % 4; // ramp launches away from the connected neighbor
    const center = this.cellWorldCenter(cell);

    const tile = new RoadTile(this.RAPIER, this.world, cell, kind, center.y, facing);
    tile.group.position.copy(center);
    this.root.add(tile.group);

    // Only ramps get their own physics collider (a tilted launch surface) — every
    // other tile kind is visual + curbs only, relying on the terrain heightfield
    // (already smooth) for support. Independent flat slabs per tile would otherwise
    // create physical steps between neighbors wherever the terrain has any slope.
    if (kind === RoadKind.Ramp) {
      const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y + SLAB_THICKNESS / 2, center.z);
      const angle = -0.42; // radians, ramps upward towards the facing direction
      const rotAxis = facing % 2 === 0 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
      const sign = facing === 0 || facing === 3 ? 1 : -1;
      const half = (angle * sign) / 2;
      const s = Math.sin(half);
      const c = Math.cos(half);
      bodyDesc.setRotation({ x: rotAxis.x * s, y: rotAxis.y * s, z: rotAxis.z * s, w: c });
      const body = this.world.createRigidBody(bodyDesc);
      const colliderDesc = this.RAPIER.ColliderDesc.cuboid(TILE_SIZE / 2, SLAB_THICKNESS / 2, TILE_SIZE * 0.75).setFriction(1.1);
      this.world.createCollider(colliderDesc, body);
    }
    this.tiles.set(cellKey(cell), tile);

    // Recompute curbs for this tile and every orthogonal neighbor tile.
    this.refreshCurbs(cell);
    for (const { dc, dr } of DIRS) {
      this.refreshCurbs({ col: cell.col + dc, row: cell.row + dr });
    }
    return true;
  }

  private refreshCurbs(cell: Cell): void {
    const tile = this.tiles.get(cellKey(cell));
    if (!tile) return;
    tile.updateConnections(this.connectionMask(cell));
  }

  /**
   * Dijkstra shortest path (weighted by tile speed, so faster tiles like
   * boost strips are preferred) from the spawn cell to the target cell.
   * Returns the ordered cell path, or null if no route exists yet.
   */
  findPath(): Cell[] | null {
    const startKey = cellKey(this.spawnCell);
    const goalKey = cellKey(this.targetCell);
    const dist = new Map<string, number>([[startKey, 0]]);
    const prev = new Map<string, Cell>();
    const visited = new Set<string>();
    const frontier: string[] = [startKey];

    while (frontier.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < frontier.length; i++) {
        if ((dist.get(frontier[i]) ?? Infinity) < (dist.get(frontier[bestIdx]) ?? Infinity)) bestIdx = i;
      }
      const currentKey = frontier.splice(bestIdx, 1)[0];
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);
      if (currentKey === goalKey) break;

      const [col, row] = currentKey.split(":").map(Number);
      const current: Cell = { col, row };
      for (const edge of this.edgesFrom(current)) {
        const edgeKey = cellKey(edge.cell);
        if (visited.has(edgeKey)) continue;
        const nd = (dist.get(currentKey) ?? Infinity) + edge.weight;
        if (nd < (dist.get(edgeKey) ?? Infinity)) {
          dist.set(edgeKey, nd);
          prev.set(edgeKey, current);
          frontier.push(edgeKey);
        }
      }
    }

    if (!dist.has(goalKey)) return null;
    const path: Cell[] = [this.targetCell];
    let currentKey = goalKey;
    while (currentKey !== startKey) {
      const p = prev.get(currentKey);
      if (!p) return null;
      path.push(p);
      currentKey = cellKey(p);
    }
    path.reverse();
    return path;
  }

  /** Orthogonal neighbors plus ramp shortcut edges (a ramp jumps 2 tiles). */
  private edgesFrom(cell: Cell): Array<{ cell: Cell; weight: number }> {
    const edges: Array<{ cell: Cell; weight: number }> = [];
    for (const { dc, dr } of DIRS) {
      const neighbor = { col: cell.col + dc, row: cell.row + dr };
      if (!this.isNetworkCell(neighbor)) continue;
      const kind = this.tiles.get(cellKey(neighbor))?.kind;
      const speed = kind ? SPEED_MULTIPLIER[kind] : 1;
      edges.push({ cell: neighbor, weight: TILE_SIZE / speed });
    }
    const tile = this.tiles.get(cellKey(cell));
    if (tile?.kind === RoadKind.Ramp) {
      const { dc, dr } = DIRS[tile.facing];
      const landing = { col: cell.col + dc * 2, row: cell.row + dr * 2 };
      if (this.isNetworkCell(landing)) {
        edges.push({ cell: landing, weight: TILE_SIZE * 1.5 });
      }
    }
    return edges;
  }

  /** Converts a cell path into world-space waypoints, using exact spawn/target positions at the ends. */
  buildWaypoints(path: Cell[], spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): THREE.Vector3[] {
    return path.map((cell, i) => {
      if (i === 0) return spawnWorld.clone();
      if (i === path.length - 1) return targetWorld.clone();
      return this.cellWorldCenter(cell);
    });
  }

  getKindAt(x: number, z: number): RoadKind | null {
    const cell = this.worldToCell(x, z);
    if (Math.abs(x - cell.col * TILE_SIZE) > TILE_SIZE / 2) return null;
    if (Math.abs(z - cell.row * TILE_SIZE) > TILE_SIZE / 2) return null;
    return this.tiles.get(cellKey(cell))?.kind ?? null;
  }

  get tileCount(): number {
    return this.tiles.size;
  }
}
