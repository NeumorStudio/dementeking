// Borra la simulación (cartera, diario, notas, sesiones) para empezar de cero.
// El perfil del navegador se conserva.
import { db } from "./db.js";

for (const table of ["meta", "holdings", "sessions", "journal", "notes", "snapshots", "orders", "missions", "activity", "lessons", "positions", "research_log", "plans", "shadow_runs", "shadow_positions", "agent_entries", "entry_exclusions",
  "howtos", "beliefs", "mission_reviews", "review_checkpoints", "briefings", "observations", "tool_errors", "api_observations", "capability_requests"]) {
  db.exec(`DELETE FROM ${table}`);
}
db.exec("DELETE FROM sqlite_sequence");
console.log("Simulación reiniciada. La próxima ejecución empezará con el capital inicial.");
