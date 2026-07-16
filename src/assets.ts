import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { recenterTemplateGeometry } from "./network";

export interface RoadAssets {
  straight: THREE.Object3D;
  straightVariant: THREE.Object3D;
  curve: THREE.Object3D;
  tJunction: THREE.Object3D;
  crossroad: THREE.Object3D;
  ramp: THREE.Object3D;
}

export interface TrackAssets {
  straight: THREE.Object3D;
  curve: THREE.Object3D;
}

export interface TrainAssets {
  locomotive: THREE.Object3D;
  carriage: THREE.Object3D;
}

export interface ShipAssets {
  boat: THREE.Object3D;
}

export interface CanalAssets {
  buoy: THREE.Object3D;
}

export interface AssetLibrary {
  carScene: THREE.Object3D;
  road: RoadAssets;
  track: TrackAssets;
  train: TrainAssets;
  ship: ShipAssets;
  canal: CanalAssets;
}

const loader = new GLTFLoader();

function loadGltf(url: string): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/**
 * Loads the Kenney GLB models used for visuals.
 *
 * Road straight/curve/T-junction/crossroad come from Kenney's city-builder
 * road set (github.com/KenneyNL/Starter-Kit-City-Builder, CC0) — the older
 * city-kit-roads pack bundled here has no dedicated curve or T piece, but
 * this one does. The ramp keeps the original city-kit-roads slant piece.
 *
 * Train track/vehicles come from Kenney's Train Kit and boats from the
 * Watercraft Kit (both CC0) — kenney.nl itself is blocked from this sandbox,
 * so these were supplied directly rather than fetched.
 */
export async function loadAssets(): Promise<AssetLibrary> {
  const base = import.meta.env.BASE_URL;
  const [
    carScene,
    straight,
    straightVariant,
    curve,
    tJunction,
    crossroad,
    ramp,
    trackStraight,
    trackCurve,
    locomotive,
    carriage,
    boat,
    buoy,
  ] = await Promise.all([
    loadGltf(`${base}assets/car/sedan.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-straight.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-straight-lightposts.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-corner.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-split.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-intersection.glb`),
    loadGltf(`${base}assets/road/road-slant-high.glb`),
    loadGltf(`${base}assets/train/railroad-straight.glb`),
    loadGltf(`${base}assets/train/railroad-corner-large.glb`),
    loadGltf(`${base}assets/train/train-locomotive-a.glb`),
    loadGltf(`${base}assets/train/train-carriage-box.glb`),
    loadGltf(`${base}assets/watercraft/boat-speed-a.glb`),
    loadGltf(`${base}assets/watercraft/buoy.glb`),
  ]);

  // The train kit's track pieces are authored with their origin at one
  // corner (e.g. railroad-straight spans z:[0,4]) rather than centered like
  // the city-builder road kit's pieces — recenter their geometry once here
  // so they drop into the same centered-template convention buildKenneyMesh
  // assumes for every other tile kind.
  recenterTemplateGeometry(trackStraight, new THREE.Box3().setFromObject(trackStraight).getCenter(new THREE.Vector3()));
  recenterTemplateGeometry(trackCurve, new THREE.Box3().setFromObject(trackCurve).getCenter(new THREE.Vector3()));

  return {
    carScene,
    road: { straight, straightVariant, curve, tJunction, crossroad, ramp },
    track: { straight: trackStraight, curve: trackCurve },
    train: { locomotive, carriage },
    ship: { boat },
    canal: { buoy },
  };
}

/**
 * Every loaded GLTF texture defaults to anisotropy=1 (no anisotropic filtering),
 * which is fine head-on but aliases into a fine flickering checkerboard/moire
 * pattern wherever a textured surface (road decals, car body) is viewed at a
 * shallow angle — exactly the game's default top-down-ish camera. Call once
 * per loaded object, after the renderer exists, so its actual hardware max is
 * known instead of guessing a fixed value.
 */
export function applyMaxAnisotropy(root: THREE.Object3D, maxAnisotropy: number): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"] as const) {
        const tex = (mat as THREE.MeshStandardMaterial)[key];
        if (tex) tex.anisotropy = maxAnisotropy;
      }
    }
  });
}
