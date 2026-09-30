// Vigilante de órdenes condicionales y de la misión. Déjalo corriendo para que las órdenes
// se ejecuten y la misión se cierre a tiempo aunque el agente no esté activo:  npm run watcher
import { config } from "./config.js";
import { startWatchLoop, watchTick } from "./sim/watch.js";

const time = () => new Date().toLocaleTimeString();
const log = (line: string) => (line.startsWith("Error") ? console.error : console.log)(`[${time()}] ${line}`);

console.log(
  `Vigilando órdenes y misión cada ${config.watchIntervalSeconds} s (las órdenes por precio cada 15 s, y todo cada ` +
    `${config.fastWatchIntervalSeconds} s en una misión rápida). Ctrl+C para salir`,
);
for (const line of await watchTick()) log(line);
startWatchLoop({ log });
