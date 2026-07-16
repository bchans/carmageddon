import { DIRS, cellKey, type Cell } from "./network";

// Fraction of the height difference between two gently-connected cells
// exchanged per second — tuned so a step change (e.g. a freshly-placed tile
// joining an already-settled stretch) visibly rushes towards a shared level
// over roughly a second, rather than snapping instantly or crawling.
const GENTLE_FLOW_RATE = 3.0;
// Fraction of an upstream waterfall pool's own excess head poured over the
// edge per second.
const WATERFALL_RATE = 2.5;
// A bed drop beyond this stops being "flat enough to pool" and starts
// cascading one-way instead. Deliberately *below* the ~0.89 a single graded
// tile-to-tile climb can carry (see MAX_GRADE_PITCH in network.ts) — a
// canal's whole point is that the player can grade it up a slope tile by
// tile the same way a road climbs a hill, and every one of those individual
// steps needs to read as a small drop/rapids, not silently keep pooling
// into one shared level that only stops once the *entire* climb has been
// treated as flat. Only a genuinely level connection (a flat junction, two
// tiles at matching elevation) stays under this and equalizes like
// connected locks.
export const WATERFALL_BED_THRESHOLD = 0.3;
// Water can never sit below its own bed — never fully "empty" mid-transient.
const MIN_DEPTH = 0.05;
// An upstream waterfall pool never drains thinner than this, so it doesn't
// visually vanish even under continuous outflow.
const MIN_POOL_DEPTH = 0.15;

interface WaterCell {
  bedHeight: number;
  waterHeight: number;
  /** Natural water bodies (lake/river/ocean) are pinned at a fixed level —
   * infinite reservoirs that source or sink flow to/from anything connected
   * to them without rising or draining themselves. */
  fixed: boolean;
}

/**
 * A minimal shallow-water simulation running over every "wet" tile cell —
 * both natural water bodies and placed canal tiles, in the *same* map, so a
 * canal that reaches a lake actually exchanges water with it instead of
 * being a disconnected system. Small enough (well under a thousand cells,
 * never a dense per-vertex terrain grid) to simulate on the CPU every
 * physics tick with no shader/GPGPU machinery needed.
 *
 * Two connected cells with a gentle bed difference equalize towards a shared
 * level, like connected canal locks. A bed difference past
 * WATERFALL_BED_THRESHOLD instead cascades one-way, driven only by the
 * upper pool's own excess depth above its bed — so a canal climbing into a
 * cliff doesn't just raise the whole network to the highest tile's level,
 * it actually waterfalls down instead.
 */
export class WaterSim {
  private cells = new Map<string, WaterCell>();

  /** Registers a natural water body cell (lake/river/ocean) at a fixed level — called once at startup for every tile whose underlying terrain is naturally underwater, never touched again. */
  setNaturalCell(cell: Cell, level: number): void {
    const key = cellKey(cell);
    if (!this.cells.has(key)) this.cells.set(key, { bedHeight: level, waterHeight: level, fixed: true });
  }

  /** Registers a newly-placed canal cell, or updates an existing one's bed height after a re-grade (its current water level carries over unchanged, so a regrade causes a fresh settling transient, not a teleport). No-op if the cell turned out to coincide with an already-registered natural water cell — that just stays a fixed lake/river tile. */
  setCanalBed(cell: Cell, bedHeight: number, initialFill: number): void {
    const key = cellKey(cell);
    const existing = this.cells.get(key);
    if (existing) {
      if (!existing.fixed) existing.bedHeight = bedHeight;
      return;
    }
    this.cells.set(key, { bedHeight, waterHeight: bedHeight + initialFill, fixed: false });
  }

  getWaterHeight(cell: Cell): number | undefined {
    return this.cells.get(cellKey(cell))?.waterHeight;
  }

  bedHeight(cell: Cell): number | undefined {
    return this.cells.get(cellKey(cell))?.bedHeight;
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

        const bedDrop = cell.bedHeight - neighbor.bedHeight; // positive: `cell` is upstream of `neighbor`
        if (Math.abs(bedDrop) > WATERFALL_BED_THRESHOLD) {
          const [upKey, upCell, downKey, downCell] =
            bedDrop > 0 ? [key, cell, neighborKey, neighbor] : [neighborKey, neighbor, key, cell];
          // Bounded by two independent things: the upstream pool can't drain
          // past its own floor (availableHead), and — just as importantly —
          // the flow has to taper off as the *downstream* side fills up
          // towards the upstream's own water level (levelGap), not just
          // however much excess the upstream side happens to have. Without
          // that second bound a downstream basin with no further outlet of
          // its own (lower than both its neighbors) absorbs cascade inflow
          // forever with nothing capping it, ballooning arbitrarily deep
          // instead of settling once it reaches the level actually feeding
          // it.
          const availableHead = upCell.waterHeight - upCell.bedHeight - MIN_POOL_DEPTH;
          const levelGap = upCell.waterHeight - downCell.waterHeight;
          const drive = Math.min(availableHead, levelGap);
          if (drive > 0) {
            const flow = Math.min(drive * WATERFALL_RATE * dt, drive);
            if (!upCell.fixed) deltas.set(upKey, (deltas.get(upKey) ?? 0) - flow);
            if (!downCell.fixed) deltas.set(downKey, (deltas.get(downKey) ?? 0) + flow);
          }
        } else {
          const diff = cell.waterHeight - neighbor.waterHeight;
          // Capped at half the remaining difference so a single step can
          // never overshoot past equalization, regardless of flow rate*dt.
          const flow = Math.sign(diff) * Math.min(Math.abs(diff) * GENTLE_FLOW_RATE * dt, Math.abs(diff) / 2);
          deltas.set(key, (deltas.get(key) ?? 0) - flow);
          deltas.set(neighborKey, (deltas.get(neighborKey) ?? 0) + flow);
        }
      }
    }

    for (const [key, cell] of this.cells) {
      if (cell.fixed) continue; // pinned regardless of any computed delta
      cell.waterHeight = Math.max(cell.bedHeight + MIN_DEPTH, cell.waterHeight + (deltas.get(key) ?? 0));
    }
  }
}
