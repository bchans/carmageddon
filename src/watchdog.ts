// Diagnoses "the tab froze" reports. JS is single-threaded, so nothing on
// the main thread can detect or log a stall *while* it's happening — this
// only catches stalls that are long-but-finite (a GC pause, one expensive
// synchronous computation, a slow leak) and eventually release control
// back to the event loop, which covers the overwhelming majority of real
// "page unresponsive" reports. A genuine infinite loop that never yields
// can't be caught this way at all (nothing can run until it returns) — that
// needs a separate Worker heartbeat instead, deliberately left out here to
// keep this slim.
//
// How it works: beat() is called once per rendered frame with a cheap
// snapshot of what the frame was about to do. A setInterval on its own
// timer (independent of the render loop) checks how long it's been since
// *its own* previous invocation — if a scheduled check itself fires much
// later than CHECK_INTERVAL_MS, that alone proves the main thread was
// blocked for roughly that long, regardless of what the render loop has
// done in the meantime. That "regardless" matters: once a freeze ends, the
// very next animation frame reliably beats *before* the queued interval
// callback gets its turn (confirmed empirically), which would otherwise
// erase the evidence — the timestamp would already look fresh by the time
// the check runs. Keeping the previous snapshot alongside the current one
// sidesteps that race: whichever one predates the stall is still on hand.

const STALL_THRESHOLD_MS = 1200;
const CHECK_INTERVAL_MS = 300;

interface TimedSnapshot {
  atMs: number;
  snapshot: Record<string, unknown>;
}

export class Watchdog {
  private current: TimedSnapshot = { atMs: performance.now(), snapshot: {} };
  private previous: TimedSnapshot = this.current;
  private lastCheckAt = performance.now();

  constructor() {
    setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  /** Call once per frame with whatever cheap-to-read diagnostic fields matter. */
  beat(snapshot: Record<string, unknown>): void {
    this.previous = this.current;
    this.current = { atMs: performance.now(), snapshot };
  }

  private check(): void {
    const now = performance.now();
    const gap = now - this.lastCheckAt;
    this.lastCheckAt = now;
    if (gap <= STALL_THRESHOLD_MS) return;

    console.warn(
      `[watchdog] main thread was blocked for ~${Math.round(gap)}ms (a check due every ${CHECK_INTERVAL_MS}ms fired that late).`,
      `\n  state ~${Math.round(now - this.previous.atMs)}ms ago:`, this.previous.snapshot,
      `\n  state ~${Math.round(now - this.current.atMs)}ms ago (most recent, may already be post-recovery):`, this.current.snapshot,
    );
  }
}
