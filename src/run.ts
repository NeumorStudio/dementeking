import { runSession } from "./agent.js";
import { lastReviewAt, reviewIntervalMinutes } from "./sim/memory.js";
import { checkMission, getActiveMission } from "./sim/mission.js";
import { startWatchLoop } from "./sim/watch.js";
import { closeTools } from "./tools/runner.js";

process.on("SIGINT", async () => {
  console.log("\nDeteniendo…");
  await closeTools();
  process.exit(0);
});

if (!getActiveMission()) {
  console.log("No hay ninguna misión activa. Crea una con:  npm run mission -- --capital 1000 --target 1050 --hours 24");
  process.exit(1);
}

// Órdenes, futuros y misión: cada minuto, las órdenes por precio cada 15 s y todo cada 5 s en una misión rápida.
const stopWatcher = startWatchLoop({ log: (line) => (line.startsWith("Error") ? console.error : console.log)(`[vigilante] ${line}`) });

// El agente trabaja sin parar mientras la misión siga activa: si una sesión termina
// (por límite de pasos o porque el agente respondió sin herramientas), se abre otra.
// El revisor escribe la memoria del trader: prepara la misión, la revisa entre sesiones cuando toca
// y hace la retrospectiva al final. Si falla, el trader sigue trabajando igual.
const review = (task: string) => runSession({ role: "reviewer", task }).catch((err) => console.error(`[revisor] ${(err as Error).message}`));

try {
  await review("Prepara la misión.");
  while (getActiveMission()) {
    await runSession();
    await checkMission();
    const m = getActiveMission();
    if (m && Date.now() - new Date(lastReviewAt(m.id) ?? m.created_at).getTime() >= reviewIntervalMinutes(m) * 60_000) {
      await review("Vigila la misión.");
    }
    if (getActiveMission()) {
      console.log("La misión sigue activa: nueva sesión en 1 minuto (Ctrl+C para salir)");
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
  await review("Prepara la misión.");
  console.log("La misión ha terminado. Ejecuta `npm run report` para ver el resultado.");
} finally {
  stopWatcher();
  await closeTools();
}
