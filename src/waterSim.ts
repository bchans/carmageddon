import { DIRS, cellKey, type Cell } from "./network";

// Fraction of the height difference between two connected cells exchanged
// per second — tuned so a step change (e.g. a freshly-placed tile joining an
// already-settled stretch) visibly rushes towards a shared level over
// roughly a second, rather than snapping instantly or crawling.
const FLOW_RATE = 3.0;
// Water can never sit below its own bed — never fully "empty" mid-transient.
const MIN_DEPTH = 0.05;

interface FlowCell {
  bedHeight: number;
  waterHeight: number;
}

/**
 * A minimal shallow-water simulation (an explicit height-diffusion
 * relaxation towards equilibrium — the same family of technique as the
 * classic "virtual pipes" shallow-water model, without persistent flow
 * momentum) running only over placed canal cells, not a dense terrain-wide
 * grid — small enough (tens of cells, not thousands) to simulate on the CPU
 * every physics tick with no shader/GPGPU machinery needed.
 *
 * Water flows between orthogonally-adjacent canal cells proportional to
 * their height difference and settles towards a shared level, the way
 * connected canal locks equalize. Since canal beds can now grade/slope like
 * roads (see CanalSystem), this is what makes the water surface actually
 * follow that bed profile instead of one universal flat plane.
 */
export class CanalWaterSim {
  private cells = new Map<string, FlowCell>();

  /** Registers a newly-placed cell, or updates an existing one's bed height after a re-grade (its current water level carries over unchanged, so a regrade doesn't cause a teleport — just a fresh settling transient). */
  setBed(cell: Cell, bedHeight: number, initialFill: number): void {
    const key = cellKey(cell);
    const existing = this.cells.get(key);
    if (existing) existing.bedHeight = bedHeight;
    else this.cells.set(key, { bedHeight, waterHeight: bedHeight + initialFill });
  }

  getWaterHeight(cell: Cell): number | undefined {
    return this.cells.get(cellKey(cell))?.waterHeight;
  }

  step(dt: number): void {
    const deltas = new Map<string, number>();

    // Only the N and E neighbor per cell, so each connected pair is
    // processed exactly once (the pair's other cell picks up S/W from its
    // own iteration).
    for (const [key, cell] of this.cells) {
      const [col, row] = key.split(":").map(Number);
      for (const dir of [DIRS[0], DIRS[1]]) {
        const neighborKey = cellKey({ col: col + dir.dc, row: row + dir.dr });
        const neighbor = this.cells.get(neighborKey);
        if (!neighbor) continue;
        const diff = cell.waterHeight - neighbor.waterHeight;
        // Capped at half the remaining difference so a single step can never
        // overshoot past equalization, regardless of FLOW_RATE*dt.
        const flow = Math.sign(diff) * Math.min(Math.abs(diff) * FLOW_RATE * dt, Math.abs(diff) / 2);
        deltas.set(key, (deltas.get(key) ?? 0) - flow);
        deltas.set(neighborKey, (deltas.get(neighborKey) ?? 0) + flow);
      }
    }

    for (const [key, cell] of this.cells) {
      cell.waterHeight = Math.max(cell.bedHeight + MIN_DEPTH, cell.waterHeight + (deltas.get(key) ?? 0));
    }
  }
}
