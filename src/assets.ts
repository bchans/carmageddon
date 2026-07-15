import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface RoadAssets {
  straight: THREE.Object3D;
  straightVariant: THREE.Object3D;
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
  const [carScene, straight, straightVariant, curve, tJunction, crossroad, ramp] = await Promise.all([
    loadGltf(`${base}assets/car/sedan.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-straight.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-straight-lightposts.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-corner.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-split.glb`),
    loadGltf(`${base}assets/road/citybuilder/road-intersection.glb`),
    loadGltf(`${base}assets/road/road-slant-high.glb`),
  ]);
  return { carScene, road: { straight, straightVariant, curve, tJunction, crossroad, ramp } };
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
