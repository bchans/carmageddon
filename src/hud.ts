import { type Economy, type UpgradeKey } from "./economy";

const UPGRADE_LABELS: Record<UpgradeKey, string> = {
  engine: "Engine",
  suspension: "Suspension",
  grip: "Grip",
  boost: "Boost tank",
};

export interface BuildOption {
  id: string;
  label: string;
  baseCost: number;
}

export interface HudCallbacks {
  onSelectBuild: (id: string) => void;
  onBuyUpgrade: (key: UpgradeKey) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onLocateSpawn: () => void;
  onLocateTarget: () => void;
}

export class Hud {
  private root: HTMLDivElement;
  private currencyEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private roundEl: HTMLDivElement;
  private messageEl: HTMLDivElement;
  private buildRow: HTMLDivElement;
  private buildButtons = new Map<string, { btn: HTMLButtonElement; option: BuildOption }>();
  private upgradeButtons = new Map<UpgradeKey, HTMLButtonElement>();
  private messageTimer: number | undefined;
  private callbacks: HudCallbacks;

  constructor(mount: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.root = document.createElement("div");
    this.root.className = "hud";

    const topBar = document.createElement("div");
    topBar.className = "hud-topbar";
    this.currencyEl = document.createElement("div");
    this.currencyEl.className = "hud-currency";
    this.roundEl = document.createElement("div");
    this.roundEl.className = "hud-round";
    this.statusEl = document.createElement("div");
    this.statusEl.className = "hud-phase";
    topBar.appendChild(this.currencyEl);
    topBar.appendChild(this.roundEl);
    topBar.appendChild(this.statusEl);
    this.root.appendChild(topBar);

    this.messageEl = document.createElement("div");
    this.messageEl.className = "hud-message";
    this.root.appendChild(this.messageEl);

    const buildPanel = document.createElement("div");
    buildPanel.className = "hud-build-panel";

    this.buildRow = document.createElement("div");
    this.buildRow.className = "hud-row";
    buildPanel.appendChild(this.buildRow);

    const upgradeRow = document.createElement("div");
    upgradeRow.className = "hud-row";
    for (const key of Object.keys(UPGRADE_LABELS) as UpgradeKey[]) {
      const btn = document.createElement("button");
      btn.className = "hud-btn hud-btn-upgrade";
      btn.addEventListener("click", () => callbacks.onBuyUpgrade(key));
      upgradeRow.appendChild(btn);
      this.upgradeButtons.set(key, btn);
    }
    buildPanel.appendChild(upgradeRow);

    this.root.appendChild(buildPanel);

    const viewControls = document.createElement("div");
    viewControls.className = "hud-view-controls";
    const makeViewBtn = (label: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.className = "hud-view-btn";
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      viewControls.appendChild(btn);
      return btn;
    };
    makeViewBtn("+", callbacks.onZoomIn);
    makeViewBtn("−", callbacks.onZoomOut);
    makeViewBtn("Spawn", callbacks.onLocateSpawn);
    makeViewBtn("Target", callbacks.onLocateTarget);
    this.root.appendChild(viewControls);

    mount.appendChild(this.root);
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  setRoundBanner(text: string): void {
    this.roundEl.textContent = text;
  }

  /** Rebuilds the build-palette row for whichever transport is active this round. */
  setBuildOptions(options: BuildOption[]): void {
    this.buildRow.replaceChildren();
    this.buildButtons.clear();
    for (const option of options) {
      const btn = document.createElement("button");
      btn.className = "hud-btn";
      btn.addEventListener("click", () => this.callbacks.onSelectBuild(option.id));
      this.buildRow.appendChild(btn);
      this.buildButtons.set(option.id, { btn, option });
    }
  }

  setSelectedBuild(id: string | null): void {
    for (const [optId, { btn }] of this.buildButtons) {
      btn.classList.toggle("selected", optId === id);
    }
  }

  /** `costMultiplier` scales every build option's price (see Game.occupiedFraction — building gets pricier as the map fills up). */
  update(economy: Economy, costMultiplier = 1): void {
    this.currencyEl.textContent = `\u{1F4B0} ${Math.floor(economy.currency)}`;

    for (const { btn, option } of this.buildButtons.values()) {
      const cost = Math.round(option.baseCost * costMultiplier);
      btn.textContent = `${option.label} (${cost})`;
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
