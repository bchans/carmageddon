import { BASE_CAR_STATS, type CarStats } from "./car";
import { RoadKind } from "./roads";
import { TrackKind } from "./tracks";

// Every round now connects two full map edges (see Game.pickTargetPoint),
// which measured out to a ~13-tile median and ~23-tile worst-case straight-
// line distance across 200 sampled rounds — these two numbers are sized so
// a median-distance round is affordable in the *priciest* single-tile-kind
// network (canals, which — unlike roads — have no cheap fallback kind), with
// enough headroom that a rough p75 round doesn't leave the player stuck
// before they've ever completed a toll and earned anything.
export const STARTING_CURRENCY = 200;
export const TOLL_REWARD = 50;

export const ROAD_COST: Record<RoadKind, number> = {
  [RoadKind.Standard]: 6,
  [RoadKind.Crossroad]: 18,
  [RoadKind.Ramp]: 12,
};

export const TRACK_COST: Record<TrackKind, number> = {
  [TrackKind.Standard]: 6,
};

// Digging a canal bed is pricier than laying pavement/rail on ground that's
// already there. Charged per application, so re-digging the same tile to
// deepen it costs the same again each time.
export const CANAL_DIG_COST = 7;
// A pump is a bigger investment than a single dig — it's what makes an
// artificial lake possible at all rather than just a deeper hole.
export const PUMP_COST = 16;
// A highway sign is a modifier on an already-placed road tile, not a tile of
// its own — priced the same as the old "Boost strip" road kind it replaces.
export const HIGHWAY_SIGN_COST = 14;

// How much every build cost scales up as the map fills up (see Game's
// occupiedFraction) — the core "harder because space is taken up" knob.
export const SPACE_COST_SCALE = 1.6;

export type UpgradeKey = "engine" | "suspension" | "grip" | "boost";

const UPGRADE_BASE_COST: Record<UpgradeKey, number> = {
  engine: 15,
  suspension: 12,
  grip: 12,
  boost: 14,
};

const MAX_UPGRADE_LEVEL = 5;

export class Economy {
  currency = STARTING_CURRENCY;
  levels: Record<UpgradeKey, number> = { engine: 0, suspension: 0, grip: 0, boost: 0 };

  canAfford(cost: number): boolean {
    return this.currency >= cost;
  }

  spend(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    this.currency -= cost;
    return true;
  }

  addToll(): void {
    this.currency += TOLL_REWARD;
  }

  costForUpgrade(key: UpgradeKey): number | null {
    const level = this.levels[key];
    if (level >= MAX_UPGRADE_LEVEL) return null;
    return Math.round(UPGRADE_BASE_COST[key] * Math.pow(1.35, level));
  }

  buyUpgrade(key: UpgradeKey): boolean {
    const cost = this.costForUpgrade(key);
    if (cost === null || !this.spend(cost)) return false;
    this.levels[key] += 1;
    return true;
  }

  computeCarStats(): CarStats {
    return {
      engineForce: BASE_CAR_STATS.engineForce * (1 + 0.16 * this.levels.engine),
      brakeForce: BASE_CAR_STATS.brakeForce,
      suspensionStiffness: BASE_CAR_STATS.suspensionStiffness * (1 + 0.12 * this.levels.suspension),
      frictionSlip: BASE_CAR_STATS.frictionSlip * (1 + 0.14 * this.levels.grip),
      boostForce: BASE_CAR_STATS.boostForce,
      boostCapacity: BASE_CAR_STATS.boostCapacity * (1 + 0.3 * this.levels.boost),
    };
  }
}
