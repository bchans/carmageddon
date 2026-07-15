import * as THREE from "three";
import type { Waypoint } from "./network";

/**
 * Drives a kinematic (non-physics) vehicle along a precomputed list of
 * world-space waypoints — the same waypoint shape the car's Autopilot
 * consumes, but for train/ship movement that doesn't need a full Rapier
 * vehicle rig (no suspension/traction to simulate; it just has to visibly
 * get from A to B along the track/canal it was given).
 */
export class PathFollower {
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

  /** True once every waypoint has been consumed (call after step()). */
  get arrived(): boolean {
    return this.waypoints.length > 0 && this.index >= this.waypoints.length;
  }

  /**
   * Advances `position` in place towards the current waypoint by up to
   * `speed*dt` (halved on bend-approach waypoints, same as the car
   * autopilot's cornering slowdown). Returns the horizontal direction moved
   * this step (for facing), or null if there's nothing left to do.
   */
  step(position: THREE.Vector3, dt: number, speed: number, arriveRadius: number, finalArriveRadius: number): THREE.Vector3 | null {
    if (this.waypoints.length === 0) return null;
    while (this.index < this.waypoints.length) {
      const isLast = this.index === this.waypoints.length - 1;
      const radius = isLast ? finalArriveRadius : arriveRadius;
      const target = this.waypoints[this.index].position;
      if (position.distanceTo(target) > radius) break;
      this.index++;
    }
    if (this.index >= this.waypoints.length) return null;

    const waypoint = this.waypoints[this.index];
    // Horizontal-only for both the move step and the facing direction — a
    // grade change should raise/lower the vehicle, not pitch its nose up
    // like a plane. Height separately eases towards the waypoint's own y so
    // it still tracks a sloped track/road instead of staying flat forever.
    const toTarget = waypoint.position.clone().sub(position);
    toTarget.y = 0;
    const dist = toTarget.length();
    position.y = THREE.MathUtils.lerp(position.y, waypoint.position.y, Math.min(1, dt * 4));
    if (dist < 1e-4) return null;
    const dir = toTarget.normalize();
    const moveSpeed = waypoint.slow ? speed * 0.45 : speed;
    position.addScaledVector(dir, Math.min(dist, moveSpeed * dt));
    return dir;
  }
}
