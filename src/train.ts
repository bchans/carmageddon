import * as THREE from "three";
import type { TrainAssets } from "./assets";
import { TILE_SIZE, type Waypoint } from "./network";
import { PathFollower } from "./pathFollower";

// The Kenney train kit's own models face local +Z (verified by node name:
// "wheels-front" sits at positive z on both the locomotive and carriage),
// the opposite of the car's sedan.glb — so unlike Car (which flips an inner
// visual group because its wheel rig is built assuming +Z front), it's
// simplest here to just treat +Z as this vehicle's own forward and let
// setFromUnitVectors orient it directly.
const FORWARD = new THREE.Vector3(0, 0, 1);
const ARRIVE_RADIUS = TILE_SIZE * 0.35;
const FINAL_ARRIVE_RADIUS = TILE_SIZE * 0.45;
export const TRAIN_SPEED = 9; // units/sec, kinematic — no physics/traction to simulate

/** Clones the real Kenney locomotive + a trailing carriage, coupled with a small gap. */
function buildTrainMesh(assets: TrainAssets): THREE.Object3D {
  const group = new THREE.Group();

  const loco = assets.locomotive.clone(true);
  loco.position.z = 0;
  loco.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  group.add(loco);

  const carriage = assets.carriage.clone(true);
  // Locomotive half-length (1.3) + coupling gap + carriage half-length (1.35),
  // trailing behind (i.e. towards -Z, opposite the +Z forward convention).
  carriage.position.z = -(1.3 + 0.35 + 1.35);
  carriage.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });
  group.add(carriage);

  return group;
}

/**
 * A kinematic (non-Rapier) transport: it just needs to visibly travel its
 * track network from spawn to target, so it moves itself along the same
 * Waypoint list shape the car's Autopilot consumes, without a full vehicle
 * physics rig.
 */
export class Train {
  readonly mesh: THREE.Object3D;
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly follower = new PathFollower();

  constructor(spawn: THREE.Vector3, assets: TrainAssets) {
    this.mesh = buildTrainMesh(assets);
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

  /** `facingDir` (world-space, horizontal) orients the train to face that direction instead of the default identity rotation — used at round start so it faces into the map from its edge spawn point instead of an arbitrary heading. */
  respawn(position: THREE.Vector3, facingDir?: THREE.Vector3): void {
    this.position.copy(position);
    this.mesh.position.copy(position);
    if (facingDir) this.quaternion.setFromUnitVectors(FORWARD, facingDir);
    else this.quaternion.identity();
    this.mesh.quaternion.copy(this.quaternion);
  }

  /** Advances along the path; returns true once it has just reached the final waypoint. */
  update(dt: number): boolean {
    const dir = this.follower.step(this.position, dt, TRAIN_SPEED, ARRIVE_RADIUS, FINAL_ARRIVE_RADIUS);
    if (dir) {
      const targetQuat = new THREE.Quaternion().setFromUnitVectors(FORWARD, dir);
      this.quaternion.slerp(targetQuat, Math.min(1, dt * 3.5));
    }
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);
    return this.follower.arrived;
  }
}
