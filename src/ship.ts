import * as THREE from "three";
import type { ShipAssets } from "./assets";
import { TILE_SIZE, type Waypoint } from "./network";
import { PathFollower } from "./pathFollower";

// The Kenney watercraft kit's hull faces local +Z (verified by sampling hull
// vertices: the +Z tip is much narrower than the -Z end, i.e. a pointed bow
// vs. a flat stern) — the opposite of the car's sedan.glb — so it's simplest
// to just treat +Z as this vehicle's own forward and let setFromUnitVectors
// orient it directly, same as Train.
const FORWARD = new THREE.Vector3(0, 0, 1);
const ARRIVE_RADIUS = TILE_SIZE * 0.35;
const FINAL_ARRIVE_RADIUS = TILE_SIZE * 0.45;
export const SHIP_SPEED = 7; // units/sec, kinematic — no buoyancy/wake to simulate

function buildBoatMesh(assets: ShipAssets): THREE.Object3D {
  const boat = assets.boat.clone(true);
  boat.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  return boat;
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

  constructor(spawn: THREE.Vector3, assets: ShipAssets) {
    this.mesh = buildBoatMesh(assets);
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

  /** `facingDir` (world-space, horizontal) orients the ship to face that direction instead of the default identity rotation — used at round start so it faces into the map from its edge spawn point instead of an arbitrary heading. */
  respawn(position: THREE.Vector3, facingDir?: THREE.Vector3): void {
    this.position.copy(position);
    this.mesh.position.copy(position);
    if (facingDir) this.quaternion.setFromUnitVectors(FORWARD, facingDir);
    else this.quaternion.identity();
    this.mesh.quaternion.copy(this.quaternion);
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
