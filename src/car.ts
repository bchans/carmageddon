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
  readonly wheelMeshes: THREE.Object3D[] = [];
  stats: CarStats;
  boostFuel: number;
  /** External multiplier applied to engine force, e.g. boost pads / mud patches. */
  speedZoneMultiplier = 1;

  private steerAngle = 0;

  constructor(RAPIER: Rapier, world: RAPIER.World, spawn: THREE.Vector3, stats: CarStats = BASE_CAR_STATS) {
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

    this.mesh = buildCarMesh();
    for (const pos of WHEEL_LOCAL_POSITIONS) {
      const wheel = buildWheelMesh();
      wheel.position.set(pos.x, -CHASSIS_HALF_EXTENTS.y * 0.6, pos.z);
      this.mesh.add(wheel);
      this.wheelMeshes.push(wheel);
    }
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

  respawn(position: THREE.Vector3): void {
    this.chassisBody.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
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
      const velBlend = Math.min(1, dt * 3.5);
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

    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const wheel = this.wheelMeshes[i];
      const connection = this.controller.wheelChassisConnectionPointCs(i);
      const suspensionLength = this.controller.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const base = WHEEL_LOCAL_POSITIONS[i];
      wheel.position.set(base.x, (connection?.y ?? 0) - suspensionLength, base.z);
      const rotation = this.controller.wheelRotation(i) ?? 0;
      const steer = FRONT_WHEELS.includes(i) ? this.steerAngle : 0;
      wheel.rotation.set(0, steer, 0);
      wheel.rotation.x = rotation;
    }
  }
}

function buildCarMesh(): THREE.Group {
  const group = new THREE.Group();
  const bodyGeo = new THREE.BoxGeometry(
    CHASSIS_HALF_EXTENTS.x * 2,
    CHASSIS_HALF_EXTENTS.y * 2,
    CHASSIS_HALF_EXTENTS.z * 2,
  );
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd63c3c, roughness: 0.5, metalness: 0.2 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  group.add(body);

  const cabinGeo = new THREE.BoxGeometry(
    CHASSIS_HALF_EXTENTS.x * 1.5,
    CHASSIS_HALF_EXTENTS.y * 1.3,
    CHASSIS_HALF_EXTENTS.z * 1.0,
  );
  const cabin = new THREE.Mesh(cabinGeo, bodyMat);
  cabin.position.set(0, CHASSIS_HALF_EXTENTS.y * 1.5, 0.2);
  cabin.castShadow = true;
  group.add(cabin);

  return group;
}

function buildWheelMesh(): THREE.Object3D {
  const geo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 16);
  geo.rotateZ(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}
