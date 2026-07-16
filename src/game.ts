import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { initPhysics, type Rapier } from "./physics";
import { Terrain } from "./terrain";
import { Car } from "./car";
import { RoadSystem, RoadKind, SPEED_MULTIPLIER } from "./roads";
import { TrackSystem, TrackKind } from "./tracks";
import { CanalSystem, CanalKind } from "./canals";
import { TILE_SIZE, DIRS, cellKey, worldToCell, type Cell, type Waypoint } from "./network";
import { Train } from "./train";
import { Ship } from "./ship";
import { Economy, ROAD_COST, TRACK_COST, CANAL_COST, TOLL_REWARD, SPACE_COST_SCALE } from "./economy";
import { CameraController, MIN_ZOOM, MAX_ZOOM } from "./input";
import { Autopilot } from "./autopilot";
import { Hud, type BuildOption } from "./hud";
import { loadAssets, applyMaxAnisotropy } from "./assets";

const FIXED_DT = 1 / 60;
const TARGET_REACHED_RADIUS = TILE_SIZE * 1.1;
const SPAWN_MARGIN = 5;
const BUILD_TIME = 24; // seconds of build time before the vehicle departs each round

const CAMERA_BASE_HEIGHT = 70;
const CAMERA_BASE_BACK = 45;

type TransportKind = "car" | "train" | "ship";
const TRANSPORT_KINDS: TransportKind[] = ["car", "train", "ship"];
const TRANSPORT_LABEL: Record<TransportKind, string> = { car: "🚗 Car", train: "🚂 Train", ship: "⛴ Ship" };

const ROAD_LABELS: Record<RoadKind, string> = {
  [RoadKind.Standard]: "Road",
  [RoadKind.Mud]: "Mud (cheap, slow)",
  [RoadKind.Boost]: "Boost strip",
  [RoadKind.Crossroad]: "Crossroad",
  [RoadKind.Ramp]: "Ramp",
};
const TRACK_LABELS: Record<TrackKind, string> = { [TrackKind.Standard]: "Track" };
const CANAL_LABELS: Record<CanalKind, string> = { [CanalKind.Standard]: "Canal" };

export class Game {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock = new THREE.Clock();
  private accumulator = 0;

  private RAPIER!: Rapier;
  private world!: RAPIER.World;
  private terrain!: Terrain;
  private car!: Car;
  private train!: Train;
  private ship!: Ship;
  private roads!: RoadSystem;
  private tracks!: TrackSystem;
  private canals!: CanalSystem;
  private economy = new Economy();
  private cameraController!: CameraController;
  private autopilot = new Autopilot();
  private hud!: Hud;

  // Shared cross-transport grid occupancy — a cell claimed by one network
  // blocks every other network's canPlace(), which is what makes the three
  // transports actually start competing for space as the map fills up.
  private occupancy = new Map<string, TransportKind>();

  private selectedBuildKind = "";
  private activeTransport: TransportKind = "car";

  private carSpawn = new THREE.Vector3();
  private carSpawnEdge = 0;
  private carTarget = new THREE.Vector3();
  private trainSpawn = new THREE.Vector3();
  private trainSpawnEdge = 0;
  private trainTarget = new THREE.Vector3();
  private shipSpawn = new THREE.Vector3();
  private shipSpawnEdge = 0;
  private shipTarget = new THREE.Vector3();

  private spawnMarker!: THREE.Object3D;
  private targetMarker!: THREE.Object3D;
  private hoverMarker!: THREE.Mesh;
  private rng: () => number;
  private container: HTMLElement;

  private vehicleActive = false;
  private buildTimer = BUILD_TIME;
  private lastCountdownSecond = -1;
  private roundNumber = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.rng = mulberry32(Date.now() & 0xffffffff);
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);
    window.addEventListener("resize", this.onResize);
  }

  async start(): Promise<void> {
    const [, assets] = await Promise.all([this.initPhysicsWorld(), loadAssets()]);
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    applyMaxAnisotropy(assets.carScene, maxAnisotropy);
    for (const template of Object.values(assets.road)) applyMaxAnisotropy(template, maxAnisotropy);
    for (const template of Object.values(assets.track)) applyMaxAnisotropy(template, maxAnisotropy);
    for (const template of Object.values(assets.train)) applyMaxAnisotropy(template, maxAnisotropy);
    for (const template of Object.values(assets.ship)) applyMaxAnisotropy(template, maxAnisotropy);
    for (const template of Object.values(assets.canal)) applyMaxAnisotropy(template, maxAnisotropy);

    this.setupLights();
    this.terrain = Terrain.generate(this.RAPIER, this.world, 1);
    this.scene.add(this.terrain.mesh, this.terrain.waterMesh);

    const isCellFree = (kind: TransportKind) => (cell: Cell) => {
      const owner = this.occupancy.get(cellKey(cell));
      return owner === undefined || owner === kind;
    };
    const claimCell = (kind: TransportKind) => (cell: Cell) => this.occupancy.set(cellKey(cell), kind);

    this.roads = new RoadSystem(this.RAPIER, this.world, this.terrain, assets.road, isCellFree("car"), claimCell("car"));
    this.tracks = new TrackSystem(this.RAPIER, this.world, this.terrain, assets.track, isCellFree("train"), claimCell("train"));
    this.canals = new CanalSystem(this.RAPIER, this.world, this.terrain, assets.canal, isCellFree("ship"), claimCell("ship"));
    this.scene.add(this.roads.root, this.tracks.root, this.canals.root);

    this.carSpawnEdge = Math.floor(this.rng() * 4);
    this.carSpawn = this.pickEdgePoint(this.carSpawnEdge);
    this.trainSpawnEdge = Math.floor(this.rng() * 4);
    this.trainSpawn = this.pickEdgePoint(this.trainSpawnEdge);
    this.shipSpawnEdge = Math.floor(this.rng() * 4);
    this.shipSpawn = this.pickEdgePoint(this.shipSpawnEdge);

    const carSpawnLift = this.carSpawn.clone();
    carSpawnLift.y += 1;
    this.car = new Car(this.RAPIER, this.world, carSpawnLift, assets.carScene, this.economy.computeCarStats());
    this.car.mesh.visible = false;
    this.scene.add(this.car.mesh);

    this.train = new Train(this.trainSpawn, assets.train);
    this.train.mesh.visible = false;
    this.scene.add(this.train.mesh);

    this.ship = new Ship(this.shipSpawn, assets.ship);
    this.ship.mesh.visible = false;
    this.scene.add(this.ship.mesh);

    this.spawnMarker = buildMarker(0x4ade80, true);
    this.scene.add(this.spawnMarker);
    this.targetMarker = buildMarker(0xffd23f, false);
    this.scene.add(this.targetMarker);
    this.hoverMarker = buildHoverMarker();
    this.scene.add(this.hoverMarker);

    this.cameraController = new CameraController(this.renderer.domElement, {
      onTap: (x, y) => this.onTap(x, y),
      onHover: (x, y) => this.onHover(x, y),
    });

    this.hud = new Hud(this.container, {
      onSelectBuild: (id) => {
        this.selectedBuildKind = id;
        this.hud.setSelectedBuild(id);
      },
      onBuyUpgrade: (key) => {
        if (this.economy.buyUpgrade(key)) {
          this.car.applyUpgrades(this.economy.computeCarStats());
          this.hud.update(this.economy, this.costMultiplier());
        }
      },
      onZoomIn: () => {
        this.cameraController.zoom = Math.min(MAX_ZOOM, this.cameraController.zoom * 1.3);
      },
      onZoomOut: () => {
        this.cameraController.zoom = Math.max(MIN_ZOOM, this.cameraController.zoom / 1.3);
      },
      onLocateSpawn: () => this.cameraController.panOffset.set(this.activeSpawn().x, this.activeSpawn().z),
      onLocateTarget: () => this.cameraController.panOffset.set(this.activeTarget().x, this.activeTarget().z),
    });

    this.activeTransport = TRANSPORT_KINDS[Math.floor(this.rng() * TRANSPORT_KINDS.length)];
    this.beginRound();

    this.onResize();
    this.renderer.setAnimationLoop(this.loop);
  }

  private async initPhysicsWorld(): Promise<void> {
    this.RAPIER = await initPhysics();
    this.world = new this.RAPIER.World({ x: 0, y: -16, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3226, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    sun.shadow.camera.far = 300;
    this.scene.add(sun);
    this.scene.background = new THREE.Color(0x8fc7ff);
    this.scene.fog = new THREE.Fog(0x8fc7ff, 120, 260);
  }

  /**
   * Snaps a coordinate to the shared grid (multiples of TILE_SIZE) so a picked
   * point always lands exactly on a tile center — matching where a network's
   * cellWorldCenter() will place things, so a vehicle doesn't spawn straddling
   * a tile edge/curb where it can catch and get stuck.
   */
  private snapToGrid(v: number): number {
    return Math.round(v / TILE_SIZE) * TILE_SIZE;
  }

  /** Picks a valid (dry, not-too-steep) point along one of the map's 4 edges (0=N, 1=E, 2=S, 3=W). */
  private pickEdgePoint(edge: number): THREE.Vector3 {
    const half = this.terrain.worldSize / 2 - SPAWN_MARGIN;
    const isNS = edge === 0 || edge === 2; // fixed on Z, roams X
    const fixed = this.snapToGrid((edge === 0 || edge === 1 ? 1 : -1) * half);
    for (let attempt = 0; attempt < 60; attempt++) {
      const roam = this.snapToGrid((this.rng() * 2 - 1) * half);
      const x = isNS ? roam : fixed;
      const z = isNS ? fixed : roam;
      if (this.terrain.isUnderwaterAt(x, z)) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.9) continue;
      const p = new THREE.Vector3(x, 0, z);
      p.y = this.terrain.getHeightAt(x, z);
      return p;
    }
    const x = isNS ? 0 : fixed;
    const z = isNS ? fixed : 0;
    const p = new THREE.Vector3(x, 0, z);
    p.y = this.terrain.getHeightAt(x, z);
    return p;
  }

  /**
   * Picks a target on a random edge that isn't the spawn edge — every round
   * connects two genuinely different edges of the map, not just some far-off
   * interior point.
   */
  private pickTargetPoint(spawnEdge: number): THREE.Vector3 {
    const otherEdges = [0, 1, 2, 3].filter((e) => e !== spawnEdge);
    const edge = otherEdges[Math.floor(this.rng() * otherEdges.length)];
    return this.pickEdgePoint(edge);
  }

  /** The horizontal direction a vehicle should face when it spawns on `edge`, so it starts out driving into the map instead of towards the boundary/off the map. */
  private edgeInwardDir(edge: number): THREE.Vector3 {
    // Edge 0=N (+Z side) faces -Z inward, 1=E (+X side) faces -X, 2=S (-Z side)
    // faces +Z, 3=W (-X side) faces +X — i.e. the opposite of DIRS[edge].
    const outward = DIRS[edge];
    return new THREE.Vector3(-outward.dc, 0, -outward.dr);
  }

  private activeSpawn(): THREE.Vector3 {
    if (this.activeTransport === "car") return this.carSpawn;
    if (this.activeTransport === "train") return this.trainSpawn;
    return this.shipSpawn;
  }

  private activeTarget(): THREE.Vector3 {
    if (this.activeTransport === "car") return this.carTarget;
    if (this.activeTransport === "train") return this.trainTarget;
    return this.shipTarget;
  }

  private updateMarkers(): void {
    this.spawnMarker.position.copy(this.activeSpawn());
    this.spawnMarker.position.y += 2.2;
    this.targetMarker.position.copy(this.activeTarget());
    this.targetMarker.position.y += 2.2;
  }

  /** Fraction of the buildable grid already claimed by any transport — the "harder because space is taken up" difficulty knob. */
  private occupiedFraction(): number {
    const totalCells = Math.pow(this.terrain.worldSize / TILE_SIZE - 2, 2);
    const used = this.roads.tileCount + this.tracks.tileCount + this.canals.tileCount;
    return Math.min(1, used / totalCells);
  }

  private costMultiplier(): number {
    return 1 + this.occupiedFraction() * SPACE_COST_SCALE;
  }

  private buildOptionsFor(kind: TransportKind): BuildOption[] {
    if (kind === "car") {
      return Object.values(RoadKind).map((k) => ({ id: k, label: ROAD_LABELS[k], baseCost: ROAD_COST[k] }));
    }
    if (kind === "train") {
      return Object.values(TrackKind).map((k) => ({ id: k, label: TRACK_LABELS[k], baseCost: TRACK_COST[k] }));
    }
    return Object.values(CanalKind).map((k) => ({ id: k, label: CANAL_LABELS[k], baseCost: CANAL_COST[k] }));
  }

  /** Recomputes the active network's route and hands it to whichever vehicle is running this round. */
  private refreshPath(): void {
    if (this.activeTransport === "car") {
      const path = this.roads.findPath();
      if (path) {
        this.autopilot.setPath(this.roads.buildWaypoints(path, this.carSpawn, this.carTarget));
        this.hud.setStatus("Driving to the toll marker");
      } else {
        this.autopilot.clearPath();
        this.hud.setStatus("No route yet — build a road to continue");
      }
      return;
    }
    if (this.activeTransport === "train") {
      const path = this.tracks.findPath();
      if (path) {
        this.train.setPath(this.tracks.buildWaypoints(path, this.trainSpawn, this.trainTarget));
        this.hud.setStatus("Train en route to the toll marker");
      } else {
        this.train.clearPath();
        this.hud.setStatus("No route yet — lay track to continue");
      }
      return;
    }
    const path = this.canals.findPath();
    if (path) {
      const waypoints = this.canals.buildWaypoints(path, this.shipSpawn, this.shipTarget).map((w): Waypoint => {
        // A canal's own graded height is its carved bed, not the water
        // surface it floats on — the ship rides at a fixed water-level
        // height along its route instead of sinking to the bed.
        const p = w.position.clone();
        p.y = this.terrain.waterMesh.position.y;
        return { position: p, slow: w.slow };
      });
      this.ship.setPath(waypoints);
      this.hud.setStatus("Ship en route to the toll marker");
    } else {
      this.ship.clearPath();
      this.hud.setStatus("No route yet — dig a canal to continue");
    }
  }

  private onTap(clientX: number, clientY: number): void {
    const cell = this.raycastCell(clientX, clientY);
    if (!cell) return;

    const network = this.activeTransport === "car" ? this.roads : this.activeTransport === "train" ? this.tracks : this.canals;
    if (!network.canPlace(cell)) {
      this.hud.showMessage("Can't place there — must connect to your network, and stay off other transports' tiles.");
      return;
    }
    const baseCost =
      this.activeTransport === "car"
        ? ROAD_COST[this.selectedBuildKind as RoadKind]
        : this.activeTransport === "train"
          ? TRACK_COST[this.selectedBuildKind as TrackKind]
          : CANAL_COST[this.selectedBuildKind as CanalKind];
    const cost = Math.round(baseCost * this.costMultiplier());
    if (!this.economy.canAfford(cost)) {
      this.hud.showMessage("Not enough toll money for that.");
      return;
    }
    this.economy.spend(cost);
    if (this.activeTransport === "car") this.roads.place(cell, this.selectedBuildKind as RoadKind);
    else if (this.activeTransport === "train") this.tracks.place(cell, this.selectedBuildKind as TrackKind);
    else this.canals.place(cell, this.selectedBuildKind as CanalKind);
    this.hud.update(this.economy, this.costMultiplier());
    this.refreshPath();
  }

  private onHover(clientX: number, clientY: number): void {
    const cell = this.raycastCell(clientX, clientY);
    if (!cell) {
      this.hoverMarker.visible = false;
      return;
    }
    const network = this.activeTransport === "car" ? this.roads : this.activeTransport === "train" ? this.tracks : this.canals;
    const center = network.cellWorldCenter(cell);
    this.hoverMarker.position.set(center.x, center.y + 0.1, center.z);
    this.hoverMarker.visible = true;
    const ok = network.canPlace(cell);
    (this.hoverMarker.material as THREE.MeshBasicMaterial).color.set(ok ? 0x4ade80 : 0xef4444);
  }

  private raycaster = new THREE.Raycaster();
  private raycastCell(clientX: number, clientY: number): Cell | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain.mesh, false)[0];
    if (!hit) return null;
    return worldToCell(hit.point.x, hit.point.z);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private loop = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.accumulator += dt;
    while (this.accumulator >= FIXED_DT) {
      this.stepPhysics(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    this.cameraController.update(dt);
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  };

  private stepPhysics(dt: number): void {
    if (!this.vehicleActive) {
      this.buildTimer -= dt;
      this.updateCountdownStatus();
      this.car.speedZoneMultiplier = 1;
      this.car.update(dt, { throttle: 0, steer: 0, brake: true, boost: false });
      this.world.step();
      if (this.buildTimer <= 0) this.activateVehicle();
      return;
    }

    if (this.activeTransport === "car") {
      const p = this.car.position;
      const onRoad = this.roads.getKindAt(p.x, p.z);
      if (onRoad) {
        this.car.speedZoneMultiplier = SPEED_MULTIPLIER[onRoad];
      } else if (this.terrain.isUnderwaterAt(p.x, p.z)) {
        this.car.speedZoneMultiplier = 0.12;
      } else {
        this.car.speedZoneMultiplier = 1;
      }
      const input = this.autopilot.computeInput(p, this.car.mesh.quaternion);
      this.car.update(dt, input);
      this.world.step();

      if (this.car.position.distanceTo(this.carTarget) < TARGET_REACHED_RADIUS) this.onTollReached();
      if (this.car.position.y < -20) {
        this.car.respawn(this.carSpawn.clone().setY(this.carSpawn.y + 1), this.edgeInwardDir(this.carSpawnEdge));
      }
      return;
    }

    // Train/ship are kinematic (no Rapier body), so the world still needs a
    // step for the car's own always-present physics body/curbs, even on a
    // train/ship round.
    this.world.step();
    if (this.activeTransport === "train") {
      this.train.update(dt);
      if (this.train.position3.distanceTo(this.trainTarget) < TARGET_REACHED_RADIUS) this.onTollReached();
    } else {
      this.ship.update(dt);
      if (this.ship.position3.distanceTo(this.shipTarget) < TARGET_REACHED_RADIUS) this.onTollReached();
    }
  }

  private activateVehicle(): void {
    this.vehicleActive = true;
    if (this.activeTransport === "car") {
      this.car.respawn(this.carSpawn.clone().setY(this.carSpawn.y + 1), this.edgeInwardDir(this.carSpawnEdge));
      this.car.mesh.visible = true;
    } else if (this.activeTransport === "train") {
      this.train.respawn(this.trainSpawn, this.edgeInwardDir(this.trainSpawnEdge));
      this.train.mesh.visible = true;
    } else {
      this.ship.respawn(this.shipSpawn.clone().setY(this.terrain.waterMesh.position.y), this.edgeInwardDir(this.shipSpawnEdge));
      this.ship.mesh.visible = true;
    }
    this.refreshPath();
  }

  private updateCountdownStatus(): void {
    const seconds = Math.max(0, Math.ceil(this.buildTimer));
    if (seconds === this.lastCountdownSecond) return;
    this.lastCountdownSecond = seconds;
    this.hud.setStatus(`Build phase — ${TRANSPORT_LABEL[this.activeTransport]} departs in ${seconds}s`);
  }

  private onTollReached(): void {
    this.economy.addToll();
    this.roundNumber += 1;
    this.activeTransport = TRANSPORT_KINDS[Math.floor(this.rng() * TRANSPORT_KINDS.length)];
    this.hud.showMessage(`Toll paid! +${TOLL_REWARD} — next round is ${TRANSPORT_LABEL[this.activeTransport]}.`);
    this.beginRound();
  }

  /** Shared setup for both the very first round and every subsequent round transition. */
  private beginRound(): void {
    this.car.mesh.visible = false;
    this.train.mesh.visible = false;
    this.ship.mesh.visible = false;

    if (this.activeTransport === "car") {
      this.carTarget = this.pickTargetPoint(this.carSpawnEdge);
      this.roads.setEndpoints(this.carSpawn, this.carTarget);
    } else if (this.activeTransport === "train") {
      this.trainTarget = this.pickTargetPoint(this.trainSpawnEdge);
      this.tracks.setEndpoints(this.trainSpawn, this.trainTarget);
    } else {
      this.shipTarget = this.pickTargetPoint(this.shipSpawnEdge);
      this.canals.setEndpoints(this.shipSpawn, this.shipTarget);
    }

    this.updateMarkers();
    this.hud.setRoundBanner(`Round ${this.roundNumber + 1} — ${TRANSPORT_LABEL[this.activeTransport]}`);
    this.hud.setBuildOptions(this.buildOptionsFor(this.activeTransport));
    const firstOption = this.buildOptionsFor(this.activeTransport)[0];
    this.selectedBuildKind = firstOption.id;
    this.hud.setSelectedBuild(this.selectedBuildKind);
    this.hud.update(this.economy, this.costMultiplier());

    this.vehicleActive = false;
    this.buildTimer = BUILD_TIME;
    this.lastCountdownSecond = -1;
    this.autopilot.clearPath();
    this.train.clearPath();
    this.ship.clearPath();
    this.updateCountdownStatus();
  }

  private updateCamera(): void {
    this.cameraController.clampPan(this.terrain.worldSize / 2 - 10);
    const center = new THREE.Vector3(this.cameraController.panOffset.x, 0, this.cameraController.panOffset.y);
    const zoom = this.cameraController.zoom;
    this.camera.position.set(center.x, CAMERA_BASE_HEIGHT / zoom, center.z + CAMERA_BASE_BACK / zoom);
    this.camera.lookAt(center);
  }
}

/** A pin-style marker; `pointUp` makes it an upward "start here" arrow instead of a downward landing pin. */
function buildMarker(color: number, pointUp: boolean): THREE.Object3D {
  const group = new THREE.Group();
  const geo = new THREE.ConeGeometry(1.1, 2.4, 12);
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
  const cone = new THREE.Mesh(geo, mat);
  if (!pointUp) cone.rotation.x = Math.PI;
  group.add(cone);
  return group;
}

function buildHoverMarker(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(TILE_SIZE * 0.9, 0.1, TILE_SIZE * 0.9);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.55 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
