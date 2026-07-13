import type { CarInput } from "./car";

const KEY_FORWARD = ["KeyW", "ArrowUp"];
const KEY_BACK = ["KeyS", "ArrowDown"];
const KEY_LEFT = ["KeyA", "ArrowLeft"];
const KEY_RIGHT = ["KeyD", "ArrowRight"];
const KEY_BRAKE = ["Space"];
const KEY_BOOST = ["ShiftLeft", "ShiftRight"];

export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export class InputController {
  private keys = new Set<string>();
  private touchThrottle = 0;
  private touchSteer = 0;
  private touchBoost = false;
  readonly touchUi: HTMLDivElement | null = null;

  constructor(mountPoint: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    if (isTouchDevice()) {
      this.touchUi = this.buildTouchUi();
      mountPoint.appendChild(this.touchUi);
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private held(codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  getCarInput(): CarInput {
    let throttle = this.touchThrottle;
    let steer = this.touchSteer;
    if (this.held(KEY_FORWARD)) throttle = 1;
    else if (this.held(KEY_BACK)) throttle = -1;
    if (this.held(KEY_LEFT)) steer = -1;
    else if (this.held(KEY_RIGHT)) steer = 1;

    return {
      throttle,
      steer,
      brake: this.held(KEY_BRAKE),
      boost: this.held(KEY_BOOST) || this.touchBoost,
    };
  }

  private buildTouchUi(): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "touch-controls";

    const stick = document.createElement("div");
    stick.className = "touch-stick";
    const knob = document.createElement("div");
    knob.className = "touch-stick-knob";
    stick.appendChild(knob);
    wrap.appendChild(stick);

    let activeTouchId: number | null = null;
    const updateFromEvent = (touch: Touch): void => {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = clamp((touch.clientX - cx) / (rect.width / 2), -1, 1);
      const dy = clamp((touch.clientY - cy) / (rect.height / 2), -1, 1);
      this.touchSteer = dx;
      this.touchThrottle = -dy;
      knob.style.transform = `translate(${dx * 30}px, ${dy * 30}px)`;
    };

    stick.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      activeTouchId = t.identifier;
      updateFromEvent(t);
      e.preventDefault();
    });
    stick.addEventListener("touchmove", (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === activeTouchId) updateFromEvent(t);
      }
      e.preventDefault();
    });
    const endTouch = (e: TouchEvent): void => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId) {
          activeTouchId = null;
          this.touchSteer = 0;
          this.touchThrottle = 0;
          knob.style.transform = "translate(0, 0)";
        }
      }
    };
    stick.addEventListener("touchend", endTouch);
    stick.addEventListener("touchcancel", endTouch);

    const boostBtn = document.createElement("div");
    boostBtn.className = "touch-boost";
    boostBtn.textContent = "BOOST";
    boostBtn.addEventListener("touchstart", (e) => {
      this.touchBoost = true;
      e.preventDefault();
    });
    boostBtn.addEventListener("touchend", (e) => {
      this.touchBoost = false;
      e.preventDefault();
    });
    wrap.appendChild(boostBtn);

    return wrap;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.touchUi?.remove();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
