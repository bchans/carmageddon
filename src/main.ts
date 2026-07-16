import "./style.css";
import { Game } from "./game";
import { inspectCells } from "./inspect";
import { worldToCell, type Cell } from "./network";

const app = document.querySelector<HTMLDivElement>("#app")!;
const game = new Game(app);
game.start();

// Console hooks for manual/scripted testing and bug reporting — always on
// (not gated to dev builds), since these are meant to be used against
// whatever's actually deployed, not just a local dev server.
(window as unknown as { __game: Game }).__game = game;

function toCellArray(input: unknown): Cell[] {
  if (Array.isArray(input) && input.length === 2 && typeof input[0] === "number" && typeof input[1] === "number") {
    return [{ col: input[0], row: input[1] }];
  }
  if (Array.isArray(input)) return input as Cell[];
  if (input && typeof input === "object") return [input as Cell];
  return [];
}

/**
 * Dumps rich diagnostics (terrain, water, every network's tile/bed/slope,
 * and the same for all 4 neighbors) for one or more grid cells straight to
 * the console as JSON, ready to copy-paste when reporting a bug.
 *
 *   __inspect(2, 3)                              // one cell
 *   __inspect([2, 3])                             // same, array form
 *   __inspect([{col:2,row:3},{col:2,row:4}])       // several cells
 *
 * Don't know the col/row of the tile you care about? Hover your mouse over
 * it in the game first, then call __inspectHover() instead — no
 * coordinates needed.
 */
(window as unknown as { __inspect: (...args: unknown[]) => unknown }).__inspect = (...args: unknown[]) => {
  const cells =
    args.length === 2 && typeof args[0] === "number" && typeof args[1] === "number"
      ? [{ col: args[0], row: args[1] }]
      : toCellArray(args[0]);
  if (cells.length === 0) {
    console.warn("[inspect] usage: __inspect(col, row) or __inspect([{col,row}, ...])");
    return null;
  }
  const result = inspectCells(game, cells);
  console.log(JSON.stringify(result, null, 2));
  return result;
};

/** Inspects whatever tile the mouse is currently (or was last) hovering over — no coordinates needed. */
(window as unknown as { __inspectHover: () => unknown }).__inspectHover = () => {
  const marker = (game as unknown as Record<string, { visible: boolean; position: { x: number; z: number } }>)["hoverMarker"];
  if (!marker || !marker.visible) {
    console.warn("[inspect] hover the mouse over a tile on the map first, then call __inspectHover() again.");
    return null;
  }
  const cell = worldToCell(marker.position.x, marker.position.z);
  const result = inspectCells(game, [cell]);
  console.log(JSON.stringify(result, null, 2));
  return result;
};
