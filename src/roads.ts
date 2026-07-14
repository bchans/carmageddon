import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";
import type { Terrain } from "./terrain";
import type { RoadAssets } from "./assets";

export const TILE_SIZE = 4;
const CURB_HEIGHT = 0.6;
const CURB_THICKNESS = 0.25;
const ROAD_WIDTH = 2.6;
// Height the pavement decal sits above the (now flattened-flush) terrain, purely
// to avoid z-fighting with the ground mesh underneath it.
const DECAL_HEIGHT = 0.08;

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

/** Direction index pointing from `from` to `to`, or null if they aren't orthogonal neighbors. */
function directionBetween(from: Cell, to: Cell): number | null {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  for (let d = 0; d < 4; d++) {
    if (DIRS[d].dc === dc && DIRS[d].dr === dr) return d;
  }
  return null;
}

class RoadTile {
  readonly cell: Cell;
  readonly kind: RoadKind;
  readonly group = new THREE.Group();
  private curbBodies: RAPIER.RigidBody[] = [];
  private curbMeshes: THREE.Object3D[] = [];
  private roadMesh: THREE.Object3D | null = null;
  private readonly world: RAPIER.World;
  private readonly RAPIER: Rapier;
  private readonly centerHeight: number;
  private readonly roadAssets: RoadAssets;
  /** For ramps: the direction (index into DIRS) the ramp launches towards. */
  readonly facing: number;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    cell: Cell,
    kind: RoadKind,
    centerHeight: number,
    facing: number,
    roadAssets: RoadAssets,
  ) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.cell = cell;
    this.kind = kind;
    this.centerHeight = centerHeight;
    this.facing = facing;
    this.roadAssets = roadAssets;
  }

  /** Rebuild the road surface shape and the perpendicular curb walls to match current neighbors. */
  updateConnections(connectedMask: boolean[]): void {
    if (this.roadMesh) {
      this.group.remove(this.roadMesh);
      disposeObject3D(this.roadMesh);
    }
    this.roadMesh = buildTileMesh(this.kind, this.facing, connectedMask, this.roadAssets);
    this.group.add(this.roadMesh);

    for (const body of this.curbBodies) this.world.removeRigidBody(body);
    this.curbBodies = [];
    for (const mesh of this.curbMeshes) this.group.remove(mesh);
    this.curbMeshes = [];

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
    const y = this.centerHeight + DECAL_HEIGHT + CURB_HEIGHT / 2;

    const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(hx, CURB_HEIGHT / 2, hz).setFriction(0.9);
    this.world.createCollider(colliderDesc, body);
    this.curbBodies.push(body);

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, CURB_HEIGHT, hz * 2),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.8 }),
    );
    mesh.position.set(x - center.x, CURB_HEIGHT / 2 + DECAL_HEIGHT, z - center.z);
    mesh.castShadow = true;
    this.group.add(mesh);
    this.curbMeshes.push(mesh);
  }
}

function cellCenter(cell: Cell): THREE.Vector3 {
  return new THREE.Vector3(cell.col * TILE_SIZE, 0, cell.row * TILE_SIZE);
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const mat = child.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}

// --- Procedural road surfaces --------------------------------------------
//
// Every road kind other than Ramp is built from flat decal geometry sized to
// the tile's actual connectivity (a straight strip, a corner arc, or a full
// intersection plate), so a tile's shape always matches how it connects to
// its neighbors instead of a fixed template baked in at placement time.

const TILE_BASE_COLOR: Record<RoadKind, number> = {
  [RoadKind.Standard]: 0x5b6270,
  [RoadKind.Crossroad]: 0x5b6270,
  [RoadKind.Ramp]: 0xaeb4bd,
  [RoadKind.Boost]: 0xe8862c,
  [RoadKind.Mud]: 0x5a4429,
};
const TILE_LINE_COLOR: Record<RoadKind, string> = {
  [RoadKind.Standard]: "#eef1f5",
  [RoadKind.Crossroad]: "#eef1f5",
  [RoadKind.Ramp]: "#eef1f5",
  [RoadKind.Boost]: "#fff4e0",
  [RoadKind.Mud]: "#8a6b3f",
};

const laneTextures = new Map<RoadKind, THREE.CanvasTexture>();
function laneTextureFor(kind: RoadKind): THREE.CanvasTexture {
  let tex = laneTextures.get(kind);
  if (tex) return tex;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `#${TILE_BASE_COLOR[kind].toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = TILE_LINE_COLOR[kind];
  ctx.fillRect(size * 0.46, size * 0.08, size * 0.08, size * 0.32);
  ctx.fillRect(size * 0.46, size * 0.6, size * 0.08, size * 0.32);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  laneTextures.set(kind, tex);
  return tex;
}

function buildStraightMesh(kind: RoadKind, axisIsZ: boolean): THREE.Object3D {
  const width = axisIsZ ? ROAD_WIDTH : TILE_SIZE;
  const depth = axisIsZ ? TILE_SIZE : ROAD_WIDTH;
  const geo = new THREE.PlaneGeometry(width, depth);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ map: laneTextureFor(kind), roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = DECAL_HEIGHT;
  mesh.receiveShadow = true;
  return mesh;
}

function buildPlateMesh(kind: RoadKind): THREE.Object3D {
  const geo = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: TILE_BASE_COLOR[kind], roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = DECAL_HEIGHT;
  mesh.receiveShadow = true;
  return mesh;
}

/** Builds a quarter-annulus pavement strip connecting the two given (tile-local) edge directions. */
function buildCurveGeometry(dirA: number, dirB: number): THREE.BufferGeometry {
  const A = DIRS[dirA];
  const B = DIRS[dirB];
  const half = TILE_SIZE / 2;
  const cx = (A.dc + B.dc) * half;
  const cz = (A.dr + B.dr) * half;
  const angleA = Math.atan2(-B.dr, -B.dc);
  const angleB = Math.atan2(-A.dr, -A.dc);
  let delta = angleB - angleA;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  const inner = half - ROAD_WIDTH / 2;
  const outer = half + ROAD_WIDTH / 2;
  const segments = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ang = angleA + delta * t;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    positions.push(cx + inner * cos, DECAL_HEIGHT, cz + inner * sin);
    positions.push(cx + outer * cos, DECAL_HEIGHT, cz + outer * sin);
    if (i < segments) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildCurveMesh(kind: RoadKind, dirA: number, dirB: number): THREE.Object3D {
  const geo = buildCurveGeometry(dirA, dirB);
  const mat = new THREE.MeshStandardMaterial({ color: TILE_BASE_COLOR[kind], roughness: 0.95, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildRampMesh(facing: number, roadAssets: RoadAssets): THREE.Object3D {
  const mesh = roadAssets.ramp.clone(true);
  mesh.scale.setScalar(TILE_SIZE);
  mesh.rotation.set(0, facing * (Math.PI / 2), 0);
  mesh.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const base = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const cloned = (base as THREE.MeshStandardMaterial).clone();
    // Drop the source atlas texture (a dark asphalt swatch) so the ramp reads
    // as the same flat grey as the rest of the procedural road pieces.
    cloned.map = null;
    cloned.color = new THREE.Color(TILE_BASE_COLOR[RoadKind.Ramp]);
    obj.material = cloned;
  });
  return mesh;
}

/** Picks straight / curve / intersection-plate shape from the tile's actual live connectivity. */
function buildTileMesh(kind: RoadKind, facing: number, mask: boolean[], roadAssets: RoadAssets): THREE.Object3D {
  if (kind === RoadKind.Ramp) return buildRampMesh(facing, roadAssets);
  if (kind === RoadKind.Crossroad) return buildPlateMesh(kind);

  const dirs = [0, 1, 2, 3].filter((d) => mask[d]);
  if (dirs.length >= 3) return buildPlateMesh(kind);
  if (dirs.length === 2) {
    const [a, b] = dirs;
    const opposite = (a + 2) % 4 === b;
    if (opposite) return buildStraightMesh(kind, a % 2 === 0);
    return buildCurveMesh(kind, a, b);
  }
  if (dirs.length === 1) return buildStraightMesh(kind, dirs[0] % 2 === 0);
  return buildStraightMesh(kind, true);
}

export class RoadSystem {
  readonly root = new THREE.Group();
  private readonly tiles = new Map<string, RoadTile>();
  private readonly RAPIER: Rapier;
  private readonly world: RAPIER.World;
  private readonly terrain: Terrain;
  private readonly roadAssets: RoadAssets;
  private spawnCell: Cell = { col: 0, row: 0 };
  private targetCell: Cell = { col: 0, row: 0 };

  constructor(RAPIER: Rapier, world: RAPIER.World, terrain: Terrain, roadAssets: RoadAssets) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.terrain = terrain;
    this.roadAssets = roadAssets;
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

  /** Flat target height for a new tile: the average terrain height at each already-connected edge. */
  private computeFlatHeight(cell: Cell, mask: boolean[]): number {
    const center = cellCenter(cell);
    const heights: number[] = [];
    for (let dir = 0; dir < 4; dir++) {
      if (!mask[dir]) continue;
      const { dc, dr } = DIRS[dir];
      heights.push(this.terrain.getHeightAt(center.x + (dc * TILE_SIZE) / 2, center.z + (dr * TILE_SIZE) / 2));
    }
    if (heights.length === 0) return this.terrain.getHeightAt(center.x, center.z);
    return heights.reduce((a, b) => a + b, 0) / heights.length;
  }

  place(cell: Cell, kind: RoadKind): boolean {
    if (!this.canPlace(cell)) return false;
    const incoming = this.incomingDirection(cell)!;
    const facing = (incoming + 2) % 4; // ramp launches away from the connected neighbor
    const mask = this.connectionMask(cell);

    // Grade the ground flat under the tile first so the pavement and its
    // physics both sit flush with the (now-levelled) terrain underneath.
    const flatHeight = this.computeFlatHeight(cell, mask);
    const center = cellCenter(cell);
    this.terrain.flattenForRoad(center.x, center.z, TILE_SIZE / 2, flatHeight);
    center.y = flatHeight;

    const tile = new RoadTile(this.RAPIER, this.world, cell, kind, center.y, facing, this.roadAssets);
    tile.group.position.copy(center);
    this.root.add(tile.group);

    // Only ramps get their own physics collider (a tilted launch surface) — every
    // other tile kind is visual + curbs only, relying on the (now-flattened)
    // terrain heightfield for support.
    if (kind === RoadKind.Ramp) {
      const bodyDesc = this.RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y + DECAL_HEIGHT / 2, center.z);
      const angle = -0.42; // radians, ramps upward towards the facing direction
      const rotAxis = facing % 2 === 0 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
      const sign = facing === 0 || facing === 3 ? 1 : -1;
      const half = (angle * sign) / 2;
      const s = Math.sin(half);
      const c = Math.cos(half);
      bodyDesc.setRotation({ x: rotAxis.x * s, y: rotAxis.y * s, z: rotAxis.z * s, w: c });
      const body = this.world.createRigidBody(bodyDesc);
      const colliderDesc = this.RAPIER.ColliderDesc.cuboid(TILE_SIZE / 2, DECAL_HEIGHT / 2, TILE_SIZE * 0.75).setFriction(1.1);
      this.world.createCollider(colliderDesc, body);
    }
    this.tiles.set(cellKey(cell), tile);

    // Recompute shape/curbs for this tile and every orthogonal neighbor tile
    // (a neighbor's own shape may need to upgrade, e.g. straight -> curve).
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

  /**
   * Samples points along the tile's actual curve for a bend, so the autopilot
   * hugs the pavement through a turn instead of cutting straight across the
   * tile from one neighbor's center to the next.
   */
  private sampleBendPoints(cell: Cell, dirIn: number, dirOut: number): THREE.Vector3[] {
    const center = this.cellWorldCenter(cell);
    if ((dirIn + 2) % 4 === dirOut) return [center]; // straight-through, one point suffices

    const A = DIRS[dirIn];
    const B = DIRS[dirOut];
    const half = TILE_SIZE / 2;
    const cx = center.x + (A.dc + B.dc) * half;
    const cz = center.z + (A.dr + B.dr) * half;
    const angleA = Math.atan2(-B.dr, -B.dc);
    const angleB = Math.atan2(-A.dr, -A.dc);
    let delta = angleB - angleA;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    const samples = 3;
    const points: THREE.Vector3[] = [];
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const ang = angleA + delta * t;
      points.push(new THREE.Vector3(cx + Math.cos(ang) * half, center.y, cz + Math.sin(ang) * half));
    }
    return points;
  }

  /** Converts a cell path into world-space waypoints, tracing curves through bends and using exact spawn/target positions at the ends. */
  buildWaypoints(path: Cell[], spawnWorld: THREE.Vector3, targetWorld: THREE.Vector3): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < path.length; i++) {
      if (i === 0) {
        points.push(spawnWorld.clone());
        continue;
      }
      if (i === path.length - 1) {
        points.push(targetWorld.clone());
        continue;
      }
      const cell = path[i];
      const dirIn = directionBetween(cell, path[i - 1]);
      const dirOut = directionBetween(cell, path[i + 1]);
      if (dirIn !== null && dirOut !== null) {
        points.push(...this.sampleBendPoints(cell, dirIn, dirOut));
      } else {
        points.push(this.cellWorldCenter(cell));
      }
    }
    return points;
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
