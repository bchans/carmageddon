import { RoadKind } from "./roads";
import { ROAD_COST, type Economy, type UpgradeKey } from "./economy";

export type GamePhase = "build" | "drive";

const ROAD_LABELS: Record<RoadKind, string> = {
  [RoadKind.Standard]: "Road",
  [RoadKind.Mud]: "Mud (cheap, slow)",
  [RoadKind.Boost]: "Boost strip",
  [RoadKind.Crossroad]: "Crossroad",
  [RoadKind.Ramp]: "Ramp",
};

const UPGRADE_LABELS: Record<UpgradeKey, string> = {
  engine: "Engine",
  suspension: "Suspension",
  grip: "Grip",
  boost: "Boost tank",
};

export interface HudCallbacks {
  onSelectRoad: (kind: RoadKind) => void;
  onBuyUpgrade: (key: UpgradeKey) => void;
  onStartDrive: () => void;
}

export class Hud {
  private root: HTMLDivElement;
  private currencyEl: HTMLDivElement;
  private phaseEl: HTMLDivElement;
  private messageEl: HTMLDivElement;
  private roadButtons = new Map<RoadKind, HTMLButtonElement>();
  private upgradeButtons = new Map<UpgradeKey, HTMLButtonElement>();
  private startDriveBtn: HTMLButtonElement;
  private buildPanel: HTMLDivElement;
  private messageTimer: number | undefined;

  constructor(mount: HTMLElement, callbacks: HudCallbacks) {
    this.root = document.createElement("div");
    this.root.className = "hud";

    const topBar = document.createElement("div");
    topBar.className = "hud-topbar";
    this.currencyEl = document.createElement("div");
    this.currencyEl.className = "hud-currency";
    this.phaseEl = document.createElement("div");
    this.phaseEl.className = "hud-phase";
    topBar.appendChild(this.currencyEl);
    topBar.appendChild(this.phaseEl);
    this.root.appendChild(topBar);

    this.messageEl = document.createElement("div");
    this.messageEl.className = "hud-message";
    this.root.appendChild(this.messageEl);

    this.buildPanel = document.createElement("div");
    this.buildPanel.className = "hud-build-panel";

    const roadRow = document.createElement("div");
    roadRow.className = "hud-row";
    for (const kind of Object.values(RoadKind)) {
      const btn = document.createElement("button");
      btn.className = "hud-btn";
      btn.addEventListener("click", () => callbacks.onSelectRoad(kind));
      roadRow.appendChild(btn);
      this.roadButtons.set(kind, btn);
    }
    this.buildPanel.appendChild(roadRow);

    const upgradeRow = document.createElement("div");
    upgradeRow.className = "hud-row";
    for (const key of Object.keys(UPGRADE_LABELS) as UpgradeKey[]) {
      const btn = document.createElement("button");
      btn.className = "hud-btn hud-btn-upgrade";
      btn.addEventListener("click", () => callbacks.onBuyUpgrade(key));
      upgradeRow.appendChild(btn);
      this.upgradeButtons.set(key, btn);
    }
    this.buildPanel.appendChild(upgradeRow);

    this.startDriveBtn = document.createElement("button");
    this.startDriveBtn.className = "hud-btn hud-btn-primary";
    this.startDriveBtn.textContent = "Start driving →";
    this.startDriveBtn.addEventListener("click", () => callbacks.onStartDrive());
    this.buildPanel.appendChild(this.startDriveBtn);

    this.root.appendChild(this.buildPanel);
    mount.appendChild(this.root);
  }

  setPhase(phase: GamePhase): void {
    this.phaseEl.textContent =
      phase === "build" ? "BUILD: place roads, then drive" : "DRIVE: reach the toll marker";
    this.buildPanel.style.display = phase === "build" ? "flex" : "none";
  }

  setSelectedRoad(kind: RoadKind | null): void {
    for (const [k, btn] of this.roadButtons) {
      btn.classList.toggle("selected", k === kind);
    }
  }

  update(economy: Economy): void {
    this.currencyEl.textContent = `\u{1F4B0} ${Math.floor(economy.currency)}`;

    for (const [kind, btn] of this.roadButtons) {
      const cost = ROAD_COST[kind];
      btn.textContent = `${ROAD_LABELS[kind]} (${cost})`;
      btn.disabled = economy.currency < cost;
    }

    for (const [key, btn] of this.upgradeButtons) {
      const cost = economy.costForUpgrade(key);
      const level = economy.levels[key];
      if (cost === null) {
        btn.textContent = `${UPGRADE_LABELS[key]} MAX`;
        btn.disabled = true;
      } else {
        btn.textContent = `${UPGRADE_LABELS[key]} Lv${level} (${cost})`;
        btn.disabled = economy.currency < cost;
      }
    }
  }

  showMessage(text: string, durationMs = 2500): void {
    this.messageEl.textContent = text;
    this.messageEl.classList.add("visible");
    window.clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => {
      this.messageEl.classList.remove("visible");
    }, durationMs);
  }
}
