import "./style.css";
import { Game } from "./game";

const app = document.querySelector<HTMLDivElement>("#app")!;
const game = new Game(app);
game.start();
