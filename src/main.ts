import "./style.css";
import { Game } from "./game";

const app = document.querySelector<HTMLDivElement>("#app")!;
const game = new Game(app);
game.start();

// Dev-only hook for manual/scripted testing in the browser console.
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
