import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface RoadAssets {
  straight: THREE.Object3D;
  curve: THREE.Object3D;
  tJunction: THREE.Object3D;
  crossroad: THREE.Object3D;
  ramp: THREE.Object3D;
}

export interface AssetLibrary {
  carScene: THREE.Object3D;
  road: RoadAssets;
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
 * Loads the Kenney GLB models used for visuals. Straight/curve/T-junction/crossroad come
 * from Kenney's city-builder road set (github.com/KenneyNL/Starter-Kit-City-Builder,
 * CC0) — the older city-kit-roads pack bundled here has no dedicated curve or T piece,
 * but this one does. The ramp keeps the original city-kit-roads slant piece.
 */
export async function loadAssets(): Promise<AssetLibrary> {
  const base = import.meta.env.BASE_URL;
  const [carScene, straight, curve, tJunction, crossroad, ramp] = await Promise.all([
    loadGltf(`${base}assets/car/sedan.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-straight.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-corner.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-split.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-intersection.glb`),
    loadGltf(`${base}assets/road/road-slant-high.glb`),
  ]);
  return { carScene, road: { straight, curve, tJunction, crossroad, ramp } };
}
