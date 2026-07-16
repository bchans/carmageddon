import * as THREE from "three";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.4;
const TAP_MOVE_THRESHOLD = 6; // px
const PAN_SPEED = 0.0016; // world units per screen px per zoom unit
const KEY_PAN_SPEED = 24; // world units per second at zoom 1, for WASD/arrow-key panning
const PAN_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
const ROTATE_SPEED = 0.006; // yaw/pitch radians per screen px, middle-drag
// Pitch offset from the default viewing angle (radians): how far the player
// can tilt down toward the horizon (positive) or up toward top-down
// (negative) — clamped so the camera can never dip below the horizon or
// flip past straight-down.
export const MIN_PITCH_OFFSET = -0.65;
export const MAX_PITCH_OFFSET = 0.85;

export interface CameraControllerCallbacks {
  onTap: (clientX: number, clientY: number) => void;
  onHover: (clientX: number, clientY: number) => void;
}

/**
 * Pointer-driven camera rig for a top-down builder view: drag to pan,
 * wheel/pinch to zoom, and a plain tap/click (no drag) passes through to
 * the game for road-tile placement.
 */
export class CameraController {
  readonly panOffset = new THREE.Vector2(0, 0);
  zoom = 1;
  /** Horizontal orbit angle around the look-at point, radians, free-spinning. */
  yaw = 0;
  /** Vertical tilt offset from the default viewing angle, radians, clamped. */
  pitchOffset = 0;

  private activePointers = new Map<number, { x: number; y: number; button: number }>();
  private dragMoved = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private readonly pressedKeys = new Set<string>();
  private readonly domElement: HTMLElement;
  private readonly callbacks: CameraControllerCallbacks;

  constructor(domElement: HTMLElement, callbacks: CameraControllerCallbacks) {
    this.domElement = domElement;
    this.callbacks = callbacks;
    domElement.addEventListener("pointerdown", this.onPointerDown);
    domElement.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    domElement.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    if (!PAN_KEYS.has(key)) return;
    this.pressedKeys.add(key);
    e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressedKeys.delete(e.key.toLowerCase());
  };

  /** Moves panOffset from held WASD/arrow keys; call once per rendered frame. */
  update(dt: number): void {
    if (this.pressedKeys.size === 0) return;
    let dx = 0;
    let dz = 0;
    if (this.pressedKeys.has("w") || this.pressedKeys.has("arrowup")) dz -= 1;
    if (this.pressedKeys.has("s") || this.pressedKeys.has("arrowdown")) dz += 1;
    if (this.pressedKeys.has("a") || this.pressedKeys.has("arrowleft")) dx -= 1;
    if (this.pressedKeys.has("d") || this.pressedKeys.has("arrowright")) dx += 1;
    if (dx === 0 && dz === 0) return;
    const len = Math.hypot(dx, dz);
    const speed = (KEY_PAN_SPEED / this.zoom) * dt;
    this.panOffset.x += (dx / len) * speed;
    this.panOffset.y += (dz / len) * speed;
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Suppress the browser's middle-click auto-scroll cursor — middle-drag
    // is bound to camera orbit instead.
    if (e.button === 1) e.preventDefault();
    this.domElement.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    this.dragMoved = false;
    if (this.activePointers.size === 2) {
      this.pinchStartDist = this.currentPinchDistance();
      this.pinchStartZoom = this.zoom;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.activePointers.get(e.pointerId);
    this.callbacks.onHover(e.clientX, e.clientY);
    if (!prev) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: prev.button });

    if (this.activePointers.size === 2) {
      const dist = this.currentPinchDistance();
      if (this.pinchStartDist > 0) {
        this.zoom = clamp((this.pinchStartZoom * dist) / this.pinchStartDist, MIN_ZOOM, MAX_ZOOM);
      }
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > TAP_MOVE_THRESHOLD) this.dragMoved = true;
    if (!this.dragMoved) return;

    if (prev.button === 1) {
      this.yaw -= dx * ROTATE_SPEED;
      this.pitchOffset = clamp(this.pitchOffset + dy * ROTATE_SPEED, MIN_PITCH_OFFSET, MAX_PITCH_OFFSET);
    } else {
      const scale = PAN_SPEED / this.zoom;
      this.panOffset.x -= dx * scale;
      this.panOffset.y -= dy * scale;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const wasTap = !this.dragMoved && this.activePointers.size === 1 && this.activePointers.has(e.pointerId);
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) this.pinchStartDist = 0;
    if (wasTap) this.callbacks.onTap(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  };

  private currentPinchDistance(): number {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  clampPan(maxRadius: number): void {
    const len = this.panOffset.length();
    if (len > maxRadius) this.panOffset.multiplyScalar(maxRadius / len);
  }

  dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.domElement.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.domElement.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
