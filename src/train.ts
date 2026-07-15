import * as THREE from "three";
import { TILE_SIZE, type Waypoint } from "./network";
import { PathFollower } from "./pathFollower";

const FORWARD = new THREE.Vector3(0, 0, -1);
const ARRIVE_RADIUS = TILE_SIZE * 0.35;
const FINAL_ARRIVE_RADIUS = TILE_SIZE * 0.45;
export const TRAIN_SPEED = 9; // units/sec, kinematic — no physics/traction to simulate

const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb33a2e, roughness: 0.55, metalness: 0.2 });
const cabMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.5 });
const wagonMat = new THREE.MeshStandardMaterial({ color: 0x4a5a63, roughness: 0.6 });
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.7, metalness: 0.4 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0xe8c94a, roughness: 0.4, metalness: 0.3 });

/** No Kenney train-kit reachable from this sandbox (kenney.nl is blocked by
 * the environment's network policy), so the locomotive + wagon are built
 * procedurally — low-poly boxes in the same faceted style as the terrain,
 * swappable later for a real GLB via this one function. */
function buildWheelSet(length: number, halfTrack: number): THREE.Object3D {
  const group = new THREE.Group();
  const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.12, 10);
  for (const x of [-halfTrack, halfTrack]) {
    for (const z of [-length / 2 + 0.3, length / 2 - 0.3]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.22, z);
      wheel.castShadow = true;
      group.add(wheel);
    }
  }
  return group;
}

function buildLocomotive(): THREE.Object3D {
  const group = new THREE.Group();
  const bodyLen = 2.6;

  const boiler = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, bodyLen), bodyMat);
  boiler.position.y = 0.75;
  boiler.castShadow = true;
  group.add(boiler);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.75, 0.9), cabMat);
  cab.position.set(0, 1.35, bodyLen / 2 - 0.55);
  cab.castShadow = true;
  group.add(cab);

  const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.55, 10), cabMat);
  chimney.position.set(0, 1.45, -bodyLen / 2 + 0.5);
  chimney.castShadow = true;
  group.add(chimney);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.1, bodyLen - 0.1), trimMat);
  stripe.position.y = 1.05;
  group.add(stripe);

  group.add(buildWheelSet(bodyLen, 0.65));
  return group;
}

function buildWagon(): THREE.Object3D {
  const group = new THREE.Group();
  const len = 2.1;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.85, len), wagonMat);
  box.position.y = 0.65;
  box.castShadow = true;
  group.add(box);
  group.add(buildWheelSet(len, 0.6));
  return group;
}

function buildTrainMesh(): { group: THREE.Object3D; segments: THREE.Object3D[] } {
  const group = new THREE.Group();
  const loco = buildLocomotive();
  loco.position.z = 0;
  group.add(loco);

  const wagon = buildWagon();
  wagon.position.z = 2.85;
  group.add(wagon);

  return { group, segments: [loco, wagon] };
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

  constructor(spawn: THREE.Vector3) {
    const built = buildTrainMesh();
    this.mesh = built.group;
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
