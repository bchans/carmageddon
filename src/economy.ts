import { BASE_CAR_STATS, type CarStats } from "./car";
import { RoadKind } from "./roads";

export const STARTING_CURRENCY = 30;
export const TOLL_REWARD = 28;

export const ROAD_COST: Record<RoadKind, number> = {
  [RoadKind.Standard]: 8,
  [RoadKind.Mud]: 3,
  [RoadKind.Boost]: 18,
  [RoadKind.Crossroad]: 22,
  [RoadKind.Ramp]: 16,
};

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
