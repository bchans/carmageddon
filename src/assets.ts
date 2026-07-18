import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { recenterTemplateGeometry, TILE_SIZE } from "./network";

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

export interface AssetLibrary {
  carScene: THREE.Object3D;
  road: RoadAssets;
  track: TrackAssets;
  train: TrainAssets;
  ship: ShipAssets;
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
  ]);

  // The train kit's track pieces are authored with their origin at one
  // corner (e.g. railroad-straight spans z:[0,4]) rather than centered like
  // the city-builder road kit's pieces — recenter their geometry once here
  // so they drop into the same centered-template convention buildKenneyMesh
  // assumes for every other tile kind.
  recenterTemplateGeometry(trackStraight, new THREE.Box3().setFromObject(trackStraight).getCenter(new THREE.Vector3()));
  // The curve piece can't use a plain bbox-center pivot the way the straight
  // piece does: its "large radius" sweep legitimately bulges past the tile
  // square by ~0.487 units on the north/east side only (verified straight
  // from the GLB's raw POSITION accessor: min [-4.0, 0, ~0], max [0.487,
  // 0.1, 4.487] — two of those four bounds are exact tile-edge numbers, the
  // other two aren't). Averaging that asymmetric bbox drags the pivot
  // ~0.24 units off the true tile center on both axes, and because
  // recenterTemplateGeometry bakes that pivot into the mesh's local vertex
  // positions *before* the per-placement rotation is applied, the error
  // rotates along with the piece at every orientation — every placed curve
  // ends up with its rail geometry shifted toward the corner it's NOT
  // connecting to, gapping away from the two edges (its actual N/E
  // connections) it's supposed to meet flush. This is what actually reads
  // as "the curve faces the wrong way", independent of and undiscovered by
  // the two earlier commits that only debated the rotation constant. Anchor
  // the pivot on the two genuinely tile-aligned min faces instead, so it
  // lands on the true tile center regardless of the bulge.
  const curveBox = new THREE.Box3().setFromObject(trackCurve);
  recenterTemplateGeometry(
    trackCurve,
    new THREE.Vector3(curveBox.min.x + TILE_SIZE / 2, curveBox.getCenter(new THREE.Vector3()).y, curveBox.min.z + TILE_SIZE / 2),
  );

  return {
    carScene,
    road: { straight, straightVariant, curve, tJunction, crossroad, ramp },
    track: { straight: trackStraight, curve: trackCurve },
    train: { locomotive, carriage },
    ship: { boat },
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
