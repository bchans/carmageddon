import * as THREE from "three";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.4;
const TAP_MOVE_THRESHOLD = 6; // px
const PAN_SPEED = 0.0016; // world units per screen px per zoom unit

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

  private activePointers = new Map<number, { x: number; y: number }>();
  private dragMoved = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  private readonly domElement: HTMLElement;
  private readonly callbacks: CameraControllerCallbacks;

  constructor(domElement: HTMLElement, callbacks: CameraControllerCallbacks) {
    this.domElement = domElement;
    this.callbacks = callbacks;
    domElement.addEventListener("pointerdown", this.onPointerDown);
    domElement.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    domElement.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.domElement.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

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
    if (this.dragMoved) {
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
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
