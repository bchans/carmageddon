import * as THREE from "three";
import type { CarInput } from "./car";
import { MAX_STEER, WHEELBASE } from "./car";
import { TILE_SIZE, type Waypoint } from "./roads";

// Small enough that the closely-spaced points sampled along a road curve
// (see RoadSystem.sampleBendPoints) get consumed one at a time instead of
// several at once, so the car actually tracks the arc through a bend
// instead of cutting straight across the tile.
const ARRIVE_RADIUS = TILE_SIZE * 0.35;
const FINAL_ARRIVE_RADIUS = TILE_SIZE * 0.45;

/**
 * Drives the car itself along a precomputed list of world-space waypoints —
 * the player only builds roads, they never touch the wheel.
 */
export class Autopilot {
  private waypoints: Waypoint[] = [];
  private index = 0;

  setPath(waypoints: Waypoint[]): void {
    this.waypoints = waypoints;
    this.index = 0;
  }

  clearPath(): void {
    this.waypoints = [];
    this.index = 0;
  }

  get hasPath(): boolean {
    return this.waypoints.length > 0;
  }

  computeInput(carPosition: THREE.Vector3, carQuaternion: THREE.Quaternion): CarInput {
    const idle: CarInput = { throttle: 0, steer: 0, brake: true, boost: false };
    if (this.waypoints.length === 0) return idle;

    while (this.index < this.waypoints.length) {
      const target = this.waypoints[this.index].position;
      const toTarget = target.clone().sub(carPosition);
      toTarget.y = 0;
      const isLast = this.index === this.waypoints.length - 1;
      const radius = isLast ? FINAL_ARRIVE_RADIUS : ARRIVE_RADIUS;
      if (toTarget.length() > radius) break;
      this.index++;
    }
    if (this.index >= this.waypoints.length) return idle;

    const waypoint = this.waypoints[this.index];
    const target = waypoint.position;
    const toTarget = target.clone().sub(carPosition);
    toTarget.y = 0;
    if (toTarget.lengthSq() < 1e-6) return { throttle: 1, steer: 0, brake: false, boost: false };
    toTarget.normalize();

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(carQuaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuaternion);
    forward.y = 0;
    right.y = 0;
    forward.normalize();
    right.normalize();

    // Pure Pursuit: the required front-wheel angle to arc onto a point
    // `lookahead` away with lateral offset implied by `alpha` is
    // atan(2*wheelbase*sin(alpha) / lookahead). Unlike naive angle-proportional
    // steering, this accounts for distance too, so it doesn't overshoot into a
    // stable orbit around a target that's off to the side.
    const lookahead = target.clone().sub(carPosition);
    lookahead.y = 0;
    const lookaheadDist = Math.max(lookahead.length(), 0.5);
    const alpha = Math.atan2(toTarget.dot(right), toTarget.dot(forward));
    const wheelAngle = Math.atan2(2 * WHEELBASE * Math.sin(alpha), lookaheadDist);
    const steer = THREE.MathUtils.clamp(wheelAngle / MAX_STEER, -1, 1);

    // Slows down harder for a sharp heading change so the car doesn't carry enough
    // momentum to run wide through a tight road bend and clip the outer curb. The
    // `slow` tag (set on and just before a bend's arc points) makes this kick in
    // before the car is already mid-turn, since alpha alone only reacts once the
    // current target itself demands a sharp turn.
    const absAlpha = Math.abs(alpha);
    let throttle = THREE.MathUtils.clamp(1 - absAlpha / (Math.PI * 0.35), 0.22, 1);
    if (waypoint.slow) throttle = Math.min(throttle, 0.45);
    // Boost is for straightaways only — boosting into a turn is exactly what sends
    // the car's momentum wide into the curb instead of following the bend.
    const boost = absAlpha < 0.3 && !waypoint.slow;

    return { throttle, steer, brake: false, boost };
  }
}
