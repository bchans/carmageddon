import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface RoadAssets {
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

/** Loads the Kenney car-kit / city-kit-roads GLB models used for visuals. Straight/crossroad/curve
 * road pieces are built procedurally (see roads.ts) so tiles can connect correctly and stay
 * grey/white regardless of how many neighbors a tile ends up with; only the ramp keeps its GLB. */
export async function loadAssets(): Promise<AssetLibrary> {
  const base = import.meta.env.BASE_URL;
  const [carScene, ramp] = await Promise.all([
    loadGltf(`${base}assets/car/sedan.glb`),
    loadGltf(`${base}assets/road/road-slant-high.glb`),
  ]);
  return { carScene, road: { ramp } };
}
