import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { initPhysics, type Rapier } from "./physics";
import { Terrain } from "./terrain";
import { Car } from "./car";
import { RoadSystem, RoadKind, TILE_SIZE, SPEED_MULTIPLIER } from "./roads";
import { Economy, ROAD_COST, TOLL_REWARD } from "./economy";
import { CameraController } from "./input";
import { Autopilot } from "./autopilot";
import { Hud } from "./hud";

const FIXED_DT = 1 / 60;
const TARGET_REACHED_RADIUS = TILE_SIZE * 1.1;
const SPAWN_MARGIN = 10;
const BUILD_TIME = 24; // seconds of build time before the car departs each round

// The very first target sits close to spawn (cheap, quick win); each round
// after that pushes the next target progressively farther out, so difficulty
// ramps instead of demanding a full map-width connection from round one.
const MIN_TARGET_DIST = 16;
const RAMP_ROUNDS = 6;

const CAMERA_BASE_HEIGHT = 70;
const CAMERA_BASE_BACK = 45;

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
  private roads!: RoadSystem;
  private economy = new Economy();
  private cameraController!: CameraController;
  private autopilot = new Autopilot();
  private hud!: Hud;

  private selectedRoadKind: RoadKind = RoadKind.Standard;
  private spawnWorld = new THREE.Vector3();
  private targetWorld = new THREE.Vector3();
  private spawnMarker!: THREE.Object3D;
  private targetMarker!: THREE.Object3D;
  private hoverMarker!: THREE.Mesh;
  private rng: () => number;
  private container: HTMLElement;

  private carActive = false;
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
    this.RAPIER = await initPhysics();
    this.world = new this.RAPIER.World({ x: 0, y: -16, z: 0 });
    this.world.timestep = FIXED_DT;

    this.setupLights();
    this.terrain = Terrain.generate(this.RAPIER, this.world, 1);
    this.scene.add(this.terrain.mesh, this.terrain.waterMesh);

    this.roads = new RoadSystem(this.RAPIER, this.world, this.terrain);
    this.scene.add(this.roads.root);

    this.spawnWorld = this.pickEdgePoint(-1);
    this.targetWorld = this.pickTargetPoint();
    this.roads.setEndpoints(this.spawnWorld, this.targetWorld);

    const initialSpawn = this.spawnWorld.clone();
    initialSpawn.y += 1;
    this.car = new Car(this.RAPIER, this.world, initialSpawn, this.economy.computeCarStats());
    this.car.mesh.visible = false; // hidden until the build countdown elapses
    this.scene.add(this.car.mesh);

    this.spawnMarker = buildMarker(0x4ade80, true);
    this.scene.add(this.spawnMarker);
    this.spawnMarker.position.copy(this.spawnWorld);
    this.spawnMarker.position.y += 2.2;

    this.targetMarker = buildMarker(0xffd23f, false);
    this.scene.add(this.targetMarker);
    this.hoverMarker = buildHoverMarker();
    this.scene.add(this.hoverMarker);
    this.updateTargetMarker();

    this.cameraController = new CameraController(this.renderer.domElement, {
      onTap: (x, y) => this.onTap(x, y),
      onHover: (x, y) => this.onHover(x, y),
    });

    this.hud = new Hud(this.container, {
      onSelectRoad: (kind) => {
        this.selectedRoadKind = kind;
        this.hud.setSelectedRoad(kind);
      },
      onBuyUpgrade: (key) => {
        if (this.economy.buyUpgrade(key)) {
          this.car.applyUpgrades(this.economy.computeCarStats());
          this.hud.update(this.economy);
        }
      },
    });
    this.hud.setSelectedRoad(this.selectedRoadKind);
    this.hud.update(this.economy);
    this.updateCountdownStatus();

    this.onResize();
    this.renderer.setAnimationLoop(this.loop);
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

  /** Picks a valid (dry, not-too-steep) point along the -X or +X edge of the map. */
  private pickEdgePoint(side: -1 | 1): THREE.Vector3 {
    const half = this.terrain.worldSize / 2 - SPAWN_MARGIN;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = side * half;
      const z = (this.rng() * 2 - 1) * half;
      if (this.terrain.isUnderwaterAt(x, z)) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.9) continue;
      const p = new THREE.Vector3(x, 0, z);
      p.y = this.terrain.getHeightAt(x, z);
      return p;
    }
    const x = side * half;
    const p = new THREE.Vector3(x, 0, 0);
    p.y = this.terrain.getHeightAt(x, 0);
    return p;
  }

  /**
   * Picks a valid target at a distance from spawn that grows with the round
   * number — round 0 is a short, cheap first connection; later rounds push
   * further out towards the map edge.
   */
  private pickTargetPoint(): THREE.Vector3 {
    const half = this.terrain.worldSize / 2 - SPAWN_MARGIN;
    const maxDist = this.terrain.worldSize * 0.8;
    const targetDist = THREE.MathUtils.lerp(MIN_TARGET_DIST, maxDist, Math.min(1, this.roundNumber / RAMP_ROUNDS));

    for (let attempt = 0; attempt < 80; attempt++) {
      const angle = this.rng() * Math.PI * 2;
      const dist = targetDist * (0.75 + this.rng() * 0.25);
      const x = THREE.MathUtils.clamp(this.spawnWorld.x + Math.cos(angle) * dist, -half, half);
      const z = THREE.MathUtils.clamp(this.spawnWorld.z + Math.sin(angle) * dist, -half, half);
      if (Math.hypot(x - this.spawnWorld.x, z - this.spawnWorld.z) < MIN_TARGET_DIST * 0.6) continue;
      if (this.terrain.isUnderwaterAt(x, z)) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.9) continue;
      const p = new THREE.Vector3(x, 0, z);
      p.y = this.terrain.getHeightAt(x, z);
      return p;
    }
    return this.pickEdgePoint(1);
  }

  private updateTargetMarker(): void {
    this.targetMarker.position.copy(this.targetWorld);
    this.targetMarker.position.y += 2.2;
  }

  /** Recomputes the road network path and hands it to the autopilot. */
  private refreshPath(): void {
    const path = this.roads.findPath();
    if (path) {
      this.autopilot.setPath(this.roads.buildWaypoints(path, this.spawnWorld, this.targetWorld));
      this.hud.setStatus("Driving to the toll marker");
    } else {
      this.autopilot.clearPath();
      this.hud.setStatus("No route yet — build a road to continue");
    }
  }

  private onTap(clientX: number, clientY: number): void {
    const cell = this.raycastCell(clientX, clientY);
    if (!cell) return;
    if (!this.roads.canPlace(cell)) {
      this.hud.showMessage("Can't place there — must connect to your road network.");
      return;
    }
    const cost = ROAD_COST[this.selectedRoadKind];
    if (!this.economy.canAfford(cost)) {
      this.hud.showMessage("Not enough toll money for that.");
      return;
    }
    this.economy.spend(cost);
    this.roads.place(cell, this.selectedRoadKind);
    this.hud.update(this.economy);
    this.refreshPath();
  }

  private onHover(clientX: number, clientY: number): void {
    const cell = this.raycastCell(clientX, clientY);
    if (!cell) {
      this.hoverMarker.visible = false;
      return;
    }
    const center = this.roads.cellWorldCenter(cell);
    this.hoverMarker.position.set(center.x, center.y + 0.1, center.z);
    this.hoverMarker.visible = true;
    const ok = this.roads.canPlace(cell);
    (this.hoverMarker.material as THREE.MeshBasicMaterial).color.set(ok ? 0x4ade80 : 0xef4444);
  }

  private raycaster = new THREE.Raycaster();
  private raycastCell(clientX: number, clientY: number): { col: number; row: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain.mesh, false)[0];
    if (!hit) return null;
    return this.roads.worldToCell(hit.point.x, hit.point.z);
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
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  };

  private stepPhysics(dt: number): void {
    if (!this.carActive) {
      this.buildTimer -= dt;
      this.updateCountdownStatus();
      this.car.speedZoneMultiplier = 1;
      this.car.update(dt, { throttle: 0, steer: 0, brake: true, boost: false });
      this.world.step();
      if (this.buildTimer <= 0) this.activateCar();
      return;
    }

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

    if (this.car.position.distanceTo(this.targetWorld) < TARGET_REACHED_RADIUS) {
      this.onTollReached();
    }
    if (this.car.position.y < -20) {
      this.car.respawn(this.spawnWorld.clone().setY(this.spawnWorld.y + 1));
    }
  }

  private activateCar(): void {
    this.carActive = true;
    this.car.respawn(this.spawnWorld.clone().setY(this.spawnWorld.y + 1));
    this.car.mesh.visible = true;
    this.refreshPath();
  }

  private updateCountdownStatus(): void {
    const seconds = Math.max(0, Math.ceil(this.buildTimer));
    if (seconds === this.lastCountdownSecond) return;
    this.lastCountdownSecond = seconds;
    this.hud.setStatus(`Build phase — car departs in ${seconds}s`);
  }

  private onTollReached(): void {
    this.economy.addToll();
    this.hud.showMessage(`Toll paid! +${TOLL_REWARD} — build the next road.`);
    this.roundNumber += 1;
    this.targetWorld = this.pickTargetPoint();
    this.roads.setEndpoints(this.spawnWorld, this.targetWorld);
    this.updateTargetMarker();
    this.hud.update(this.economy);

    this.carActive = false;
    this.car.mesh.visible = false;
    this.buildTimer = BUILD_TIME;
    this.lastCountdownSecond = -1;
    this.autopilot.clearPath();
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
