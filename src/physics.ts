import RAPIER from "@dimforge/rapier3d-compat";

let ready: Promise<typeof RAPIER> | null = null;

export function initPhysics(): Promise<typeof RAPIER> {
  if (!ready) {
    ready = RAPIER.init().then(() => RAPIER);
  }
  return ready;
}

export type Rapier = typeof RAPIER;
