// Resumen de la misión en texto, pensado para leerse en el chat (también desde el móvil con Remote Control).
import { db } from "../db.js";
import { listCapabilityRequests } from "./memory.js";
import { describeCostMode } from "./costs.js";
import { getActiveMission, getLastMission, getMission, missionDurationMinutes, missionMeasurement, PREP_TIMEOUT_MINUTES, revertedEntries } from "./mission.js";
import { listOrders } from "./orders.js";
import { valuation } from "./portfolio.js";
import { listPositions } from "./positions.js";

const usd = (n: number) => `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

function timeLeft(deadline: string) {
  const min = Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export async function statusReport(missionId?: number): Promise<string> {
  const m = missionId !== undefined ? getMission(missionId) : (getActiveMission() ?? getLastMission());
  if (!m) return "No hay ninguna misión. Crea una con /dementeking:trading.";

  const v = await valuation(m.id);
  const current = m.status === "active" ? v.totalUsd : (m.final_usd ?? v.totalUsd);
  const change = ((current - m.initial_usd) / m.initial_usd) * 100;
  const progress = ((current - m.initial_usd) / (m.target_usd - m.initial_usd)) * 100;
  const statusText =
    m.status === "active"
      ? m.started_at
        ? `en curso, quedan ${timeLeft(m.deadline)}`
        : `preparándose: el reloj (${Math.round(missionDurationMinutes(m))} min) aún no ha arrancado`
      : m.end_reason === "prep_timeout"
        ? `cancelada: el reloj no arrancó en ${PREP_TIMEOUT_MINUTES} min${(() => {
            const n = revertedEntries(m.id).length;
            return n ? ` (llegaron candidatos, pero ${n === 1 ? "su compra revirtió" : `${n} compras revirtieron`})` : "";
          })()}`
        : m.status === "succeeded"
        ? "CONSEGUIDA"
        : m.status === "expired"
          ? "terminada sin llegar al objetivo"
          : m.status === "bust"
            ? "SIN FONDOS: se quedó sin dinero para operar"
            : "detenida por el usuario";

  const lines: string[] = [];
  lines.push(`Misión #${m.id}: ${statusText}`);
  lines.push(`Valor: ${usd(current)} (${pct(change)}) · objetivo ${usd(m.target_usd)} · progreso ${Math.round(progress)} %`);
  lines.push(m.instructions ? `Instrucciones: ${m.instructions}` : "Modo libre");
  if (m.mode !== "live") lines.push(`Costes: ${describeCostMode(m.cost_mode)}`);
  // Lo que tardó en prepararse (de pedirla a arrancar el reloj) y en entrar desde la señal.
  const measured = missionMeasurement(m);
  const prep = measured?.prepMinutes?.toLocaleString("es-ES");
  const timing = [
    prep === undefined
      ? ""
      : m.started_at
        ? `preparación ${prep} min`
        : m.status === "active"
          ? `preparándose desde hace ${prep} min`
          : `preparación ${prep} min, sin llegar a arrancar el reloj`,
    measured?.entryLatencySeconds != null ? `entrada a ${measured.entryLatencySeconds.toLocaleString("es-ES")} s de la señal` : "",
  ].filter(Boolean);
  if (timing.length) lines.push(`Tiempos: ${timing.join(" · ")}`);

  // Posiciones abiertas con su resultado sin realizar (valor de liquidación frente a lo que costaron).
  const open = listPositions(m.id).filter((p) => p.status === "open");
  if (m.status === "active") {
    const cash = v.holdings.filter((h) => ["USDC", "USDT"].includes(h.symbol)).reduce((s, h) => s + h.usd, 0);
    lines.push("", `Posiciones (${open.length}) · liquidez ${usd(cash)}`);
    for (const p of open) {
      // Solo la parte de la posición que sigue abierta (el saldo puede incluir, p. ej., el SOL inicial para fees).
      const h = v.holdings.find((x) => x.venue === p.venue && x.asset === p.asset);
      const share = h && h.amount > 0 ? Math.min(1, p.qtyOpen / h.amount) : 0;
      const now = (h?.usd ?? 0) * share;
      const cost = p.openCostUsd;
      lines.push(`- ${p.symbol}: ${usd(now)} (${pct(cost ? ((now - cost) / cost) * 100 : 0)} sobre ${usd(cost)})`);
    }
    const orders = listOrders(m.id, "open");
    if (orders.length) {
      lines.push(`Órdenes abiertas: ${orders.map((o: any) => (o.condition === "time" ? `#${o.id} a las ${hhmm(o.executes_at)}` : `#${o.id} si ${o.trigger_label} ${o.condition === "above" ? "≥" : "≤"} ${o.trigger_price}`)).join(" · ")}`);
    }
  }

  const closed = listPositions(m.id).filter((p) => p.status === "closed");
  if (closed.length) {
    const wins = closed.filter((p) => (p.pnlUsd ?? 0) > 0).length;
    lines.push("", `Operaciones cerradas: ${closed.length} (${wins} con beneficio)`);
    for (const p of closed.slice(0, 4)) lines.push(`- ${p.symbol}: ${pct(p.pnlPct ?? 0)} en ${p.heldMinutes} min (${p.exitReason ?? "venta"})`);
  }

  // Lo último que ha hecho y anotado el agente.
  const recent = db
    .prepare("SELECT ts, kind, summary, reasoning FROM journal WHERE mission_id = ? AND kind NOT IN ('rejected') ORDER BY id DESC LIMIT 5")
    .all(m.id) as Array<{ ts: string; kind: string; summary: string; reasoning: string | null }>;
  if (recent.length) {
    lines.push("", "Últimos movimientos:");
    for (const j of recent) {
      const why = j.reasoning?.match(/^Por qué: (.*)$/m)?.[1];
      lines.push(`- ${hhmm(j.ts)} ${j.summary}${why ? ` · ${why.slice(0, 120)}` : ""}`);
    }
  }
  const notes = db
    .prepare("SELECT ts, title FROM activity WHERE kind = 'thought' AND mission_id = ? ORDER BY id DESC LIMIT 2")
    .all(m.id) as Array<{ ts: string; title: string }>;
  if (notes.length) {
    lines.push("", "Última nota del agente:");
    for (const n of notes) lines.push(`- ${hhmm(n.ts)} ${n.title.slice(0, 220)}`);
  }

  // Lo último del revisor (el agente que escribe la memoria).
  const review = db
    .prepare("SELECT ts, title, body FROM activity WHERE kind = 'review' AND mission_id = ? ORDER BY id DESC LIMIT 1")
    .get(m.id) as { ts: string; title: string; body: string | null } | undefined;
  if (review) lines.push("", `Revisor (${hhmm(review.ts)}): ${review.title}${review.body ? ` · ${review.body.slice(0, 200)}` : ""}`);

  // Capacidades que el agente ha pedido y el usuario aún no ha contestado.
  const requests = listCapabilityRequests("open");
  if (requests.length) {
    lines.push("", `El agente pide (${requests.length}, revísalas con /dementeking:peticiones):`);
    for (const r of requests.slice(0, 3)) lines.push(`- ${r.capability}${r.times_requested > 1 ? ` (${r.times_requested} veces)` : ""}`);
  }
  return lines.join("\n");
}
