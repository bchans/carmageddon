import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { initPhysics, type Rapier } from "./physics";
import { Terrain } from "./terrain";
import { Car } from "./car";
import { RoadSystem, RoadKind, TILE_SIZE, SPEED_MULTIPLIER } from "./roads";
import { Economy, ROAD_COST, TOLL_REWARD } from "./economy";
import { InputController } from "./input";
import { Hud, type GamePhase } from "./hud";

const FIXED_DT = 1 / 60;
const TARGET_REACHED_RADIUS = TILE_SIZE * 1.1;
const SPAWN_MARGIN = 14;

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
  private input!: InputController;
  private hud!: Hud;

  private phase: GamePhase = "build";
  private selectedRoadKind: RoadKind = RoadKind.Standard;
  private spawnWorld = new THREE.Vector3();
  private targetWorld = new THREE.Vector3();
  private targetMarker!: THREE.Object3D;
  private hoverMarker!: THREE.Mesh;
  private rng: () => number;
  private levelSeed = 1;

  private cameraPitch = 0.32;
  private cameraDistance = 9;
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.rng = mulberry32(Date.now() & 0xffffffff);
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
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
    this.terrain = Terrain.generate(this.RAPIER, this.world, this.levelSeed);
    this.scene.add(this.terrain.mesh, this.terrain.waterMesh);

    this.roads = new RoadSystem(this.RAPIER, this.world, this.terrain);
    this.scene.add(this.roads.root);

    this.spawnWorld = this.pickEdgePoint(-1);
    this.targetWorld = this.pickEdgePoint(1);
    this.roads.setEndpoints(this.spawnWorld, this.targetWorld);

    const initialSpawn = this.spawnWorld.clone();
    initialSpawn.y += 1;
    this.car = new Car(this.RAPIER, this.world, initialSpawn, this.economy.computeCarStats());
    this.scene.add(this.car.mesh);

    this.targetMarker = buildMarker(0xffd23f);
    this.scene.add(this.targetMarker);
    this.hoverMarker = buildHoverMarker();
    this.scene.add(this.hoverMarker);
    this.updateTargetMarker();

    this.input = new InputController(this.container);
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
      onStartDrive: () => this.setPhase("drive"),
    });
    this.hud.setSelectedRoad(this.selectedRoadKind);
    this.setPhase("build");
    this.hud.update(this.economy);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
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

  private setPhase(phase: GamePhase): void {
    this.phase = phase;
    this.hud.setPhase(phase);
    if (phase === "drive") {
      const spawn = this.spawnWorld.clone();
      spawn.y += 1;
      this.car.respawn(spawn);
    }
  }

  private updateTargetMarker(): void {
    this.targetMarker.position.copy(this.targetWorld);
    this.targetMarker.position.y += 2.2;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.phase !== "build") return;
    const cell = this.raycastCell(event);
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
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.phase !== "build") {
      this.hoverMarker.visible = false;
      return;
    }
    const cell = this.raycastCell(event);
    if (!cell) {
      this.hoverMarker.visible = false;
      return;
    }
    const center = this.roads.cellWorldCenter(cell);
    this.hoverMarker.position.set(center.x, center.y + 0.1, center.z);
    this.hoverMarker.visible = true;
    const ok = this.roads.canPlace(cell);
    (this.hoverMarker.material as THREE.MeshBasicMaterial).color.set(ok ? 0x4ade80 : 0xef4444);
  };

  private raycaster = new THREE.Raycaster();
  private raycastCell(event: PointerEvent): { col: number; row: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
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
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private stepPhysics(dt: number): void {
    if (this.phase === "drive") {
      const p = this.car.position;
      const onRoad = this.roads.getKindAt(p.x, p.z);
      if (onRoad) {
        this.car.speedZoneMultiplier = SPEED_MULTIPLIER[onRoad];
      } else if (this.terrain.isUnderwaterAt(p.x, p.z)) {
        this.car.speedZoneMultiplier = 0.12;
      } else {
        this.car.speedZoneMultiplier = 1;
      }
      this.car.update(dt, this.input.getCarInput());
    } else {
      this.car.speedZoneMultiplier = 1;
    }
    this.world.step();

    if (this.phase === "drive" && this.car.position.distanceTo(this.targetWorld) < TARGET_REACHED_RADIUS) {
      this.onTollReached();
    }
    if (this.car.position.y < -20) {
      this.car.respawn(this.spawnWorld.clone().setY(this.spawnWorld.y + 1));
    }
  }

  private onTollReached(): void {
    this.economy.addToll();
    this.hud.showMessage(`Toll paid! +${TOLL_REWARD} — build the next road.`);
    this.levelSeed += 1;
    this.targetWorld = this.pickEdgePoint(1);
    this.roads.setEndpoints(this.spawnWorld, this.targetWorld);
    this.updateTargetMarker();
    this.hud.update(this.economy);
    this.setPhase("build");
  }

  private updateCamera(dt: number): void {
    const carPos = this.car.position;
    const carQuat = this.car.mesh.quaternion;
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    const desired = carPos
      .clone()
      .add(back.multiplyScalar(this.cameraDistance))
      .add(new THREE.Vector3(0, this.cameraDistance * this.cameraPitch, 0));
    this.camera.position.lerp(desired, Math.min(1, dt * 4));
    const lookTarget = carPos.clone().add(new THREE.Vector3(0, 1, 0));
    this.camera.lookAt(lookTarget);
  }
}

function buildMarker(color: number): THREE.Object3D {
  const group = new THREE.Group();
  const geo = new THREE.ConeGeometry(1.1, 2.4, 12);
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
  const cone = new THREE.Mesh(geo, mat);
  cone.rotation.x = Math.PI;
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
