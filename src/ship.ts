import * as THREE from "three";
import { TILE_SIZE, type Waypoint } from "./network";
import { PathFollower } from "./pathFollower";

const FORWARD = new THREE.Vector3(0, 0, -1);
const ARRIVE_RADIUS = TILE_SIZE * 0.35;
const FINAL_ARRIVE_RADIUS = TILE_SIZE * 0.45;
export const SHIP_SPEED = 7; // units/sec, kinematic — no buoyancy/wake to simulate

const hullMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.5 });
const deckMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 });
const cabinMat = new THREE.MeshStandardMaterial({ color: 0x3d5a6b, roughness: 0.45 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0xc23b3b, roughness: 0.5 });

/** No Kenney watercraft-kit reachable from this sandbox (kenney.nl is blocked
 * by the environment's network policy), so the hull is a procedural low-poly
 * boat — swappable later for a real GLB via this one function. */
function buildBoatMesh(): THREE.Object3D {
  const group = new THREE.Group();

  const hullShape = new THREE.Shape();
  hullShape.moveTo(0, -1.3);
  hullShape.quadraticCurveTo(0.7, -1.2, 0.62, -0.2);
  hullShape.lineTo(0.55, 1.1);
  hullShape.quadraticCurveTo(0.5, 1.35, 0, 1.35);
  hullShape.quadraticCurveTo(-0.5, 1.35, -0.55, 1.1);
  hullShape.lineTo(-0.62, -0.2);
  hullShape.quadraticCurveTo(-0.7, -1.2, 0, -1.3);
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 0.55, bevelEnabled: false });
  hullGeo.rotateX(-Math.PI / 2);
  hullGeo.translate(0, 0.3, 0);
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  const trim = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 2.6), trimMat);
  trim.position.y = 0.6;
  group.add(trim);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 2.2), deckMat);
  deck.position.y = 0.68;
  group.add(deck);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.6, 0.9), cabinMat);
  cabin.position.set(0, 1.02, 0.3);
  cabin.castShadow = true;
  group.add(cabin);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 8), deckMat);
  mast.position.set(0, 1.9, -0.6);
  mast.castShadow = true;
  group.add(mast);

  return group;
}

/**
 * A kinematic (non-Rapier) transport, floating at a fixed water-surface
 * height (game.ts stamps every waypoint's y to WATER_LEVEL before handing
 * them to setPath, since a canal's own graded height is its carved bed, not
 * its water surface). Adds a small idle bob/roll for a bit of life at rest.
 */
export class Ship {
  readonly mesh: THREE.Object3D;
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly follower = new PathFollower();
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(spawn: THREE.Vector3) {
    this.mesh = buildBoatMesh();
    this.position.copy(spawn);
    this.mesh.position.copy(spawn);
  }

  get position3(): THREE.Vector3 {
    return this.position.clone();
  }

  setPath(waypoints: Waypoint[]): void {
    this.follower.setPath(waypoints);
  }

  clearPath(): void {
    this.follower.clearPath();
  }

  get hasPath(): boolean {
    return this.follower.hasPath;
  }

  respawn(position: THREE.Vector3): void {
    this.position.copy(position);
    this.mesh.position.copy(position);
    this.quaternion.identity();
    this.mesh.quaternion.identity();
  }

  /** Advances along the path; returns true once it has just reached the final waypoint. */
  update(dt: number): boolean {
    const dir = this.follower.step(this.position, dt, SHIP_SPEED, ARRIVE_RADIUS, FINAL_ARRIVE_RADIUS);
    if (dir) {
      const targetQuat = new THREE.Quaternion().setFromUnitVectors(FORWARD, dir);
      this.quaternion.slerp(targetQuat, Math.min(1, dt * 2.5));
    }
    this.bobPhase += dt * 1.6;
    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(this.bobPhase) * 0.04;
    this.mesh.quaternion.copy(this.quaternion);
    this.mesh.rotation.z += Math.sin(this.bobPhase * 0.7) * 0.02;
    return this.follower.arrived;
  }
}
