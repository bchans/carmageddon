import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { Rapier } from "./physics";

export interface CarInput {
  throttle: number; // -1 (reverse) .. 1 (forward)
  steer: number; // -1 (left) .. 1 (right)
  brake: boolean;
  boost: boolean;
}

export interface CarStats {
  engineForce: number;
  brakeForce: number;
  suspensionStiffness: number;
  frictionSlip: number;
  boostForce: number;
  boostCapacity: number; // seconds of boost
}

export const BASE_CAR_STATS: CarStats = {
  engineForce: 55,
  brakeForce: 18,
  suspensionStiffness: 24,
  frictionSlip: 4.2,
  boostForce: 45,
  boostCapacity: 3,
};

const CHASSIS_HALF_EXTENTS = { x: 0.85, y: 0.32, z: 1.85 };
const WHEEL_RADIUS = 0.42;
const WHEEL_HALF_TRACK = 0.82;
const SUSPENSION_REST = 0.35;
// Kenney's sedan.glb body is 2.55 native units long; scale it to roughly
// match the (already physics-tuned) chassis length.
const MODEL_SCALE = (CHASSIS_HALF_EXTENTS.z * 2) / 2.55;
const WHEEL_NODE_NAMES = ["wheel-front-left", "wheel-front-right", "wheel-back-left", "wheel-back-right"];
export const MAX_STEER = 0.7; // radians
export const WHEELBASE = 2.5; // distance between front and rear axles (matches WHEEL_LOCAL_POSITIONS z spacing)
const MAX_SPEED = 11; // m/s cruising speed cap, used for grounded kinematic driving
const MAX_YAW_RATE = 1.8; // radians/sec, at full steer input

// Forward is local -Z (verified empirically), so the steered "front" wheels
// must sit at negative z — the leading edge in the direction of travel.
const WHEEL_LOCAL_POSITIONS: Array<{ x: number; z: number }> = [
  { x: -WHEEL_HALF_TRACK, z: -1.25 }, // front-left
  { x: WHEEL_HALF_TRACK, z: -1.25 }, // front-right
  { x: -WHEEL_HALF_TRACK, z: 1.25 }, // rear-left
  { x: WHEEL_HALF_TRACK, z: 1.25 }, // rear-right
];
const FRONT_WHEELS = [0, 1];
const DRIVE_WHEELS = [2, 3]; // rear-wheel drive: keeps steered front wheels free to turn cleanly

export class Car {
  readonly chassisBody: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly mesh: THREE.Group;
  readonly wheelMeshes: THREE.Object3D[];
  private readonly wheelBasePositions: THREE.Vector3[];
  stats: CarStats;
  boostFuel: number;
  /** External multiplier applied to engine force, e.g. boost pads / mud patches. */
  speedZoneMultiplier = 1;

  private steerAngle = 0;

  constructor(
    RAPIER: Rapier,
    world: RAPIER.World,
    spawn: THREE.Vector3,
    carScene: THREE.Object3D,
    stats: CarStats = BASE_CAR_STATS,
  ) {
    this.stats = { ...stats };
    this.boostFuel = stats.boostCapacity;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.chassisBody = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      CHASSIS_HALF_EXTENTS.x,
      CHASSIS_HALF_EXTENTS.y,
      CHASSIS_HALF_EXTENTS.z,
    )
      .setDensity(35)
      .setFriction(0.4);
    world.createCollider(colliderDesc, this.chassisBody);

    this.controller = world.createVehicleController(this.chassisBody);
    for (const pos of WHEEL_LOCAL_POSITIONS) {
      this.controller.addWheel(
        { x: pos.x, y: -CHASSIS_HALF_EXTENTS.y * 0.6, z: pos.z },
        { x: 0, y: -1, z: 0 },
        { x: 1, y: 0, z: 0 },
        SUSPENSION_REST,
        WHEEL_RADIUS,
      );
    }
    for (let i = 0; i < WHEEL_LOCAL_POSITIONS.length; i++) {
      this.controller.setWheelSuspensionStiffness(i, this.stats.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, 0.83);
      this.controller.setWheelSuspensionRelaxation(i, 0.88);
      this.controller.setWheelMaxSuspensionTravel(i, 0.35);
      this.controller.setWheelFrictionSlip(i, this.stats.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(i, 4.5);
    }

    const built = buildCarMesh(carScene);
    this.mesh = built.group;
    this.wheelMeshes = built.wheelMeshes;
    this.wheelBasePositions = built.wheelBasePositions;
  }

  get position(): THREE.Vector3 {
    const t = this.chassisBody.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get speed(): number {
    return this.controller.currentVehicleSpeed();
  }

  applyUpgrades(stats: CarStats): void {
    this.stats = { ...stats };
    for (let i = 0; i < WHEEL_LOCAL_POSITIONS.length; i++) {
      this.controller.setWheelSuspensionStiffness(i, this.stats.suspensionStiffness);
      this.controller.setWheelFrictionSlip(i, this.stats.frictionSlip);
    }
  }

  /** `facingDir` (world-space, horizontal) orients the car to face that direction instead of the default identity rotation — used at round start so it faces into the map from its edge spawn point instead of an arbitrary heading. */
  respawn(position: THREE.Vector3, facingDir?: THREE.Vector3): void {
    this.chassisBody.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (facingDir) {
      // Forward is local -Z (see WHEEL_LOCAL_POSITIONS above).
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), facingDir);
      this.chassisBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    } else {
      this.chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    }
    this.boostFuel = this.stats.boostCapacity;
  }

  update(dt: number, input: CarInput): void {
    const targetSteer = -input.steer * MAX_STEER;
    this.steerAngle = THREE.MathUtils.lerp(this.steerAngle, targetSteer, Math.min(1, dt * 8));
    for (const i of FRONT_WHEELS) {
      this.controller.setWheelSteering(i, this.steerAngle);
    }

    let forceMultiplier = this.speedZoneMultiplier;
    if (input.boost && this.boostFuel > 0 && input.throttle > 0) {
      this.boostFuel = Math.max(0, this.boostFuel - dt);
      forceMultiplier *= 1 + this.stats.boostForce / this.stats.engineForce;
    } else if (!input.boost) {
      this.boostFuel = Math.min(this.stats.boostCapacity, this.boostFuel + dt * 0.4);
    }

    const engineForce = input.throttle * this.stats.engineForce * forceMultiplier;
    for (const i of DRIVE_WHEELS) {
      this.controller.setWheelEngineForce(i, engineForce);
      this.controller.setWheelBrake(i, input.brake ? this.stats.brakeForce : 0);
    }

    this.controller.updateVehicle(dt);

    // Tire-friction alone struggles to reliably close a heading error at low
    // speed for an AI-driven car (it wide-arcs/orbits instead of turning
    // cleanly onto a waypoint). While grounded, nudge velocity and yaw rate
    // directly towards what the steering input implies; while airborne (e.g.
    // off a ramp) leave physics alone so jumps still arc and land naturally.
    const grounded = [0, 1, 2, 3].some((i) => this.controller.wheelIsInContact(i));
    if (grounded) {
      // Directly rotating the chassis (rather than nudging angular velocity)
      // sidesteps friction-based counter-torque from the chassis/wheel
      // contacts fighting the turn — setAngvel alone kept getting damped
      // back towards zero by world.step()'s contact resolution.
      // A positive rotation about world +Y turns local forward (0,0,-1)
      // towards -X, so a positive steer (target to the right, +X) needs a
      // *negative* yaw delta here.
      const yawDelta = -input.steer * MAX_YAW_RATE * dt;
      const r = this.chassisBody.rotation();
      const currentQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawDelta);
      const newQuat = deltaQuat.multiply(currentQuat).normalize();
      this.chassisBody.setRotation({ x: newQuat.x, y: newQuat.y, z: newQuat.z, w: newQuat.w }, true);
      // Clear leftover tire-friction angular momentum so world.step() doesn't
      // additionally integrate rotation on top of the direct set above.
      const residualAngvel = this.chassisBody.angvel();
      this.chassisBody.setAngvel({ x: residualAngvel.x, y: 0, z: residualAngvel.z }, true);

      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(newQuat);
      const desiredSpeed = input.throttle * MAX_SPEED * forceMultiplier;
      const desired = forward.multiplyScalar(desiredSpeed);
      const vel = this.chassisBody.linvel();
      // Snaps velocity onto the rotated heading quickly enough that momentum
      // doesn't carry the car wide through a tight road bend and into a curb.
      const velBlend = Math.min(1, dt * 6);
      this.chassisBody.setLinvel(
        {
          x: THREE.MathUtils.lerp(vel.x, desired.x, velBlend),
          y: vel.y,
          z: THREE.MathUtils.lerp(vel.z, desired.z, velBlend),
        },
        true,
      );
    }

    this.syncMesh();
  }

  private syncMesh(): void {
    const t = this.chassisBody.translation();
    const r = this.chassisBody.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);

    const restConnectionY = -CHASSIS_HALF_EXTENTS.y * 0.6;
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const wheel = this.wheelMeshes[i];
      const connection = this.controller.wheelChassisConnectionPointCs(i);
      const suspensionLength = this.controller.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      // Suspension bob relative to rest, applied on top of the model's own
      // native wheel position (rather than the physics raycast coordinates)
      // so the real wheel meshes stay correctly attached to the car body.
      const suspensionDelta = (connection?.y ?? restConnectionY) - suspensionLength - (restConnectionY - SUSPENSION_REST);
      const base = this.wheelBasePositions[i];
      wheel.position.set(base.x, base.y + suspensionDelta, base.z);
      const rotation = this.controller.wheelRotation(i) ?? 0;
      const steer = FRONT_WHEELS.includes(i) ? this.steerAngle : 0;
      wheel.rotation.set(0, steer, 0);
      wheel.rotation.x = rotation;
    }
  }
}

interface BuiltCarMesh {
  group: THREE.Group;
  wheelMeshes: THREE.Object3D[];
  wheelBasePositions: THREE.Vector3[];
}

/**
 * Builds the visual car from the loaded Kenney sedan.glb template: the body
 * and each named wheel node are detached into a fresh group, scaled to match
 * the (physics-tuned) chassis size. Wheel base positions are recorded so
 * syncMesh can animate suspension bob/steer/roll on top of the model's own
 * natural wheel placement instead of the physics raycast coordinates.
 */
function buildCarMesh(carScene: THREE.Object3D): BuiltCarMesh {
  const root = carScene.clone(true);
  const group = new THREE.Group();

  // The source model's own "wheel-front-*" nodes sit at local +Z, but forward
  // is local -Z (see WHEEL_LOCAL_POSITIONS below, and syncMesh which drives
  // `group`'s rotation straight from physics each frame) — so the hood
  // visually trails instead of leading unless the whole assembly is flipped
  // 180° first. That flip has to live on this inner `visual` group rather
  // than `group` itself, since `group`'s own rotation gets overwritten by
  // the chassis's physics quaternion every frame in syncMesh.
  const visual = new THREE.Group();
  visual.rotation.y = Math.PI;
  group.add(visual);

  const body = root.getObjectByName("body")!;
  body.scale.setScalar(MODEL_SCALE);
  body.position.multiplyScalar(MODEL_SCALE);
  visual.add(body);

  const wheelMeshes: THREE.Object3D[] = [];
  const wheelBasePositions: THREE.Vector3[] = [];
  for (const name of WHEEL_NODE_NAMES) {
    const wheel = root.getObjectByName(name)!;
    wheel.scale.setScalar(MODEL_SCALE);
    wheel.position.multiplyScalar(MODEL_SCALE);
    visual.add(wheel);
    wheelMeshes.push(wheel);
    wheelBasePositions.push(wheel.position.clone());
  }

  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  return { group, wheelMeshes, wheelBasePositions };
}
