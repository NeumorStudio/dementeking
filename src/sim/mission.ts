// Misión: capital inicial ficticio, objetivo y plazo real. Termina sola cuando la cartera
// llega al objetivo o se acaba el tiempo; entonces se cierran todas las posiciones a mercado.
// Cada misión tiene su propia cartera, órdenes, diario y posiciones.
import { db, logJournal, now } from "../db.js";
import { liquidateAll, planPortfolio, resetPortfolio, validateAllocation, valuation } from "./portfolio.js";
import { DEFAULT_ALLOCATION, type Allocation, type ChainId, type Holding } from "./types.js";
import { settleTransfers } from "./transfers.js";
import { allChains, getVenue } from "./venues/index.js";

export interface Mission {
  id: number;
  created_at: string;
  initial_usd: number;
  target_usd: number;
  deadline: string;
  status: "active" | "closing" | "succeeded" | "expired" | "bust" | "cancelled";
  ended_at: string | null;
  final_usd: number | null;
  instructions: string | null;
  reviewed_at: string | null;
  benchmark_sol_price: number | null;
  /** Reparto inicial por cadena o exchange (JSON de porcentajes). */
  allocation: string | null;
  /** Cartera inicial (JSON de saldos): la referencia "sin operar". */
  benchmark: string | null;
  /** Cuándo empezó a trabajar el agente (y arrancó el reloj); null mientras se prepara. */
  started_at: string | null;
  /** 'sim' (dinero ficticio) o 'live' (la cartera real de la IA). */
  mode: "sim" | "live";
  /** Solo live: 'manual' (el usuario aprueba cada operación) o 'auto' (dentro de los límites). */
  approval: "manual" | "auto" | null;
  /** Solo live: JSON de MissionLimits. */
  limits: string | null;
}

export interface MissionLimits {
  /** Máximo en USD por operación. */
  maxTradeUsd: number;
  /** Pérdida máxima de la misión en %: por debajo, solo se permite vender a estables. */
  maxLossPct: number;
}

export const isLive = (m: Pick<Mission, "mode"> | undefined | null) => m?.mode === "live";

export function getMission(id: number): Mission | undefined {
  return db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as Mission | undefined;
}

/** Misión activa. */
export function getActiveMission(): Mission | undefined {
  return db.prepare("SELECT * FROM missions WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() as
    | Mission
    | undefined;
}

/** Última misión, activa o no. */
export function getLastMission(): Mission | undefined {
  return db.prepare("SELECT * FROM missions ORDER BY id DESC LIMIT 1").get() as Mission | undefined;
}

/** Misiones activas (normalmente una). */
export function activeMissions(): Mission[] {
  return db.prepare("SELECT * FROM missions WHERE status = 'active' ORDER BY id").all() as unknown as Mission[];
}

/** Historial objetivo de misiones terminadas (lo calcula el simulador, no el agente). */
export function missionHistory() {
  const rows = db
    .prepare(
      `SELECT m.*, (SELECT r.origin FROM mission_reviews r WHERE r.mission_id = m.id) AS review_origin
       FROM missions m WHERE m.status NOT IN ('active', 'closing') ORDER BY m.id`,
    )
    .all() as unknown as Array<Mission & { review_origin: string | null }>;
  return rows.map((m) => {
    const minutes = Math.round((new Date(m.deadline).getTime() - new Date(m.created_at).getTime()) / 60_000);
    return {
      missionId: m.id,
      capitalUsd: m.initial_usd,
      targetUsd: m.target_usd,
      targetPct: Number((((m.target_usd - m.initial_usd) / m.initial_usd) * 100).toFixed(1)),
      durationMinutes: minutes,
      userInstructions: m.instructions ?? "ninguna (modo libre)",
      finalUsd: m.final_usd === null ? null : Number(m.final_usd.toFixed(2)),
      resultPct: m.final_usd === null ? null : Number((((m.final_usd - m.initial_usd) / m.initial_usd) * 100).toFixed(2)),
      outcome:
        m.status === "succeeded" ? "objetivo conseguido" : m.status === "expired" ? "no llegó al objetivo" : m.status === "bust" ? "sin fondos (bancarrota)" : "cancelada",
      reviewed: m.review_origin !== null || m.reviewed_at !== null,
    };
  });
}

function insertMission(args: {
  initialUsd: number;
  targetUsd: number;
  durationMinutes: number;
  instructions?: string;
  allocation: Allocation;
  holdings: Holding[];
  live?: { approval: "manual" | "auto"; limits: MissionLimits };
}): number {
  const deadline = new Date(Date.now() + args.durationMinutes * 60_000).toISOString();
  const id = Number(
    db
      .prepare(
        "INSERT INTO missions (created_at, initial_usd, target_usd, deadline, instructions, allocation, benchmark, mode, approval, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        now(),
        args.initialUsd,
        args.targetUsd,
        deadline,
        args.instructions?.trim() || null,
        JSON.stringify(args.allocation),
        JSON.stringify(args.holdings),
        args.live ? "live" : "sim",
        args.live?.approval ?? null,
        args.live ? JSON.stringify(args.live.limits) : null,
      ).lastInsertRowid,
  );
  // En una misión real, los saldos son los de la cadena (holdings es su espejo).
  resetPortfolio(id, args.holdings);
  logJournal({
    missionId: id,
    sessionId: null,
    kind: "mission",
    summary:
      `${args.live ? "Misión REAL" : "Misión"} #${id} iniciada: de ${args.initialUsd.toFixed(2)} USD a ${args.targetUsd.toFixed(2)} USD ` +
      `en ${Math.round((new Date(deadline).getTime() - Date.now()) / 60_000)} min (el reloj arranca cuando el agente empieza a trabajar)`,
  });
  return id;
}

function validate(initialUsd: number, targetUsd: number, durationMinutes: number) {
  if (!(targetUsd > initialUsd)) throw new Error("El objetivo debe ser mayor que el capital inicial");
  if (!(durationMinutes > 0)) throw new Error("La duración debe ser positiva");
}

/** Crea una misión (cancela la anterior si seguía activa). */
export async function createMission(
  initialUsd: number,
  targetUsd: number,
  durationMinutes: number,
  instructions?: string,
  allocation: Allocation = DEFAULT_ALLOCATION,
): Promise<Mission> {
  validate(initialUsd, targetUsd, durationMinutes);
  const plan = validateAllocation(allocation);
  // Precio de los nativos de las cadenas con capital, para entregar la parte de gas.
  const prices: Partial<Record<ChainId, number>> = {};
  for (const venue of Object.keys(plan)) {
    const v = getVenue(venue);
    if (v.kind !== "chain") continue;
    const price = (await v.priceUsd([v.native.address]))[v.native.address];
    if (!price) throw new Error(`No se pudo obtener el precio de ${v.native.symbol}`);
    prices[v.id] = price;
  }
  const holdings = planPortfolio(initialUsd, plan, prices);
  cancelActive();
  // Cada misión tiene su propia cartera, órdenes y notas: empieza de cero sin arrastrar nada de la anterior.
  return getMission(insertMission({ initialUsd, targetUsd, durationMinutes, instructions, allocation: plan, holdings }))!;
}

function cancelActive() {
  const previous = getActiveMission();
  if (!previous) return;
  db.prepare("UPDATE missions SET status = 'cancelled', ended_at = ? WHERE id = ?").run(now(), previous.id);
  db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ? WHERE status = 'open' AND mission_id = ?").run(now(), previous.id);
  logJournal({ missionId: previous.id, sessionId: null, kind: "mission", summary: `Misión #${previous.id} cancelada por el usuario al crear una nueva` });
}

/**
 * Misión con la cartera real de la IA. El capital inicial es lo que vale la cartera ahora (a precio de
 * liquidación) y los saldos son los de la cadena. `holdings` y `totalUsd` los lee quien llama (src/live).
 */
export function createLiveMission(args: {
  holdings: Holding[];
  totalUsd: number;
  byChain: Record<ChainId, number>;
  targetPct: number;
  durationMinutes: number;
  instructions?: string;
  approval: "manual" | "auto";
  limits: MissionLimits;
}): Mission {
  if (!(args.totalUsd >= 1)) throw new Error(`La cartera real vale ${args.totalUsd.toFixed(2)} USD: envíale fondos antes de empezar`);
  if (!(args.targetPct > 0)) throw new Error("El objetivo debe ser una subida positiva");
  if (!(args.limits.maxTradeUsd > 0) || !(args.limits.maxLossPct > 0 && args.limits.maxLossPct <= 100)) throw new Error("Límites no válidos");
  const targetUsd = Number((args.totalUsd * (1 + args.targetPct / 100)).toFixed(2));
  validate(args.totalUsd, targetUsd, args.durationMinutes);
  const allocation = Object.fromEntries(
    Object.entries(args.byChain)
      .filter(([, v]) => v > 0)
      .map(([c, v]) => [c, Number(((v / args.totalUsd) * 100).toFixed(1))]),
  ) as Allocation;
  cancelActive();
  return getMission(
    insertMission({
      initialUsd: args.totalUsd,
      targetUsd,
      durationMinutes: args.durationMinutes,
      instructions: args.instructions,
      allocation,
      holdings: args.holdings,
      live: { approval: args.approval, limits: args.limits },
    }),
  )!;
}

function remaining(deadline: string) {
  const ms = new Date(deadline).getTime() - Date.now();
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600), m = Math.floor(totalSec / 60) % 60, s = totalSec % 60;
  return { ms, seconds: totalSec, text: h ? `${h} h ${m} min` : `${m} min ${s} s` };
}

/**
 * El reloj de la misión arranca cuando el agente empieza a trabajar, no al crearla: así no se pierde
 * el tiempo que tarda en prepararse (el briefing del revisor, arrancar el agente). Solo la primera vez.
 */
export function startMissionClock(missionId: number | null) {
  if (missionId === null) return;
  const m = getMission(missionId);
  if (!m || m.status !== "active" || m.started_at) return;
  const durationMs = new Date(m.deadline).getTime() - new Date(m.created_at).getTime();
  const start = new Date();
  const changed = db
    .prepare("UPDATE missions SET started_at = ?, created_at = ?, deadline = ? WHERE id = ? AND started_at IS NULL AND status = 'active'")
    .run(start.toISOString(), start.toISOString(), new Date(start.getTime() + durationMs).toISOString(), missionId).changes;
  if (changed) logJournal({ missionId, sessionId: null, kind: "mission", summary: `El agente empieza a trabajar: el reloj de la misión #${missionId} arranca ahora` });
}

/** Estado de una misión (por defecto, la principal activa o la última). */
export async function missionStatus(missionId?: number) {
  const mission = missionId !== undefined ? getMission(missionId) : (getActiveMission() ?? getLastMission());
  if (!mission) return { active: false, message: "No hay ninguna misión. El usuario debe crear una (/dementeking:trading en Claude Code, /dementeking-trading en OpenCode)." };
  if (mission.status !== "active") {
    return {
      active: false,
      message: `La misión #${mission.id} ha terminado (${mission.status}). No se puede operar hasta que el usuario cree una nueva.`,
      mission: {
        id: mission.id,
        status: mission.status,
        mode: mission.mode,
        initialUsd: mission.initial_usd,
        targetUsd: mission.target_usd,
        finalUsd: mission.final_usd,
        deadline: mission.deadline,
        endedAt: mission.ended_at,
        instructions: mission.instructions,
      },
    };
  }
  const v = await valuation(mission.id);
  const left = remaining(mission.deadline);
  const idle = idleCheck(mission, v, left.seconds);
  return {
    ...(idle ? { warning: idle } : {}),
    active: true,
    missionId: mission.id,
    initialUsd: mission.initial_usd,
    targetUsd: mission.target_usd,
    currentUsd: Number(v.totalUsd.toFixed(2)),
    missingUsd: Number((mission.target_usd - v.totalUsd).toFixed(2)),
    progressPct: Number((((v.totalUsd - mission.initial_usd) / (mission.target_usd - mission.initial_usd)) * 100).toFixed(1)),
    now: new Date().toISOString(),
    deadline: mission.deadline,
    timeLeft: left.text,
    secondsLeft: left.seconds,
    userInstructions: mission.instructions ?? "ninguna: modo libre",
    ...(isLive(mission)
      ? {
          mode: "REAL: dinero de verdad de la cartera de la IA",
          approval: mission.approval === "manual" ? "el usuario aprueba cada operación (puede tardar hasta ~90 s)" : "autónoma dentro de los límites",
          limits: JSON.parse(mission.limits ?? "{}") as MissionLimits,
          stopsBelowUsd: Number(lossFloor(mission)!.toFixed(2)),
          stopNote: "Si la cartera baja de stopsBelowUsd, la misión se para sola: se venden los tokens a estables y termina.",
          howToTrade: "execute_swap para los swaps y execute_bridge para mover estables o el nativo entre cadenas (simulate_*, Binance y simulate_transfer no están disponibles en una misión real)",
        }
      : { mode: "simulada" }),
  };
}

/**
 * Detiene una misión por decisión del usuario (por defecto, la principal). Con closePositions,
 * cierra todas las posiciones a mercado (igual que al terminar); si no, la cartera queda tal cual.
 */
export async function stopMission(closePositions: boolean, missionId?: number): Promise<{ missionId: number; finalUsd: number; problems: string[] }> {
  const mission = missionId !== undefined ? getMission(missionId) : getActiveMission();
  if (!mission || mission.status !== "active") throw new Error("No hay ninguna misión activa");
  if (!db.prepare("UPDATE missions SET status = 'closing' WHERE id = ? AND status = 'active'").run(mission.id).changes) {
    throw new Error("La misión se está cerrando en este momento");
  }
  db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ? WHERE status = 'open' AND mission_id = ?").run(now(), mission.id);
  // Lo que está en tránsito llega: la cartera final lo incluye.
  await settleTransfers({ missionId: mission.id, force: true });
  const problems = closePositions ? await liquidateAll(mission.id, null, `Cierre manual: el usuario detuvo la misión #${mission.id}`) : [];
  const final = await valuation(mission.id, true);
  db.prepare("UPDATE missions SET status = 'cancelled', ended_at = ?, final_usd = ? WHERE id = ?").run(now(), final.totalUsd, mission.id);
  logJournal({
    missionId: mission.id,
    sessionId: null,
    kind: "mission",
    summary:
      `Misión #${mission.id} detenida por el usuario ${closePositions ? "cerrando posiciones" : "sin cerrar posiciones"}: ` +
      `${mission.initial_usd} → ${final.totalUsd.toFixed(2)} USD (objetivo ${mission.target_usd} USD)`,
    details: { problems },
  });
  return { missionId: mission.id, finalUsd: final.totalUsd, problems };
}

/** Minutos desde la última operación (o desde que empezó la misión). */
export function minutesSinceLastTrade(mission: Mission): number {
  const last = (
    db.prepare("SELECT MAX(ts) AS ts FROM journal WHERE mission_id = ? AND kind IN ('swap', 'cex_order', 'transfer') AND (reasoning IS NULL OR reasoning NOT LIKE 'Cierre %') AND (reasoning IS NULL OR reasoning NOT LIKE 'Parada %')").get(mission.id) as { ts: string | null }
  ).ts;
  return (Date.now() - new Date(last ?? mission.started_at ?? mission.created_at).getTime()) / 60_000;
}

/**
 * Aviso de "parado": lejos del objetivo, con casi todo en efectivo (estables o el nativo) y sin operar
 * desde hace un rato, quedan minutos útiles. Quedarse quieto garantiza no llegar; el agente lo racionaliza
 * a menudo tras perder ("si nada cumple la creencia, me quedo en BNB"), así que el simulador se lo dice.
 */
export function idleCheck(mission: Mission, v: Awaited<ReturnType<typeof valuation>>, secondsLeft: number): string | null {
  if (mission.status !== "active" || v.totalUsd >= mission.target_usd || secondsLeft < 90 || v.totalUsd <= 0) return null;
  const natives = new Set(allChains().map((c) => `${c.id}:${c.native.address}`));
  const cash = v.holdings.filter((h) => h.valuedBy === "stable" || natives.has(`${h.venue}:${h.asset}`)).reduce((s, h) => s + h.usd, 0);
  const cashPct = (cash / v.totalUsd) * 100;
  const durationMin = (new Date(mission.deadline).getTime() - new Date(mission.started_at ?? mission.created_at).getTime()) / 60_000;
  const idleMin = minutesSinceLastTrade(mission);
  if (cashPct < 80 || idleMin < Math.max(2, durationMin * 0.15)) return null;
  const needPct = ((mission.target_usd - v.totalUsd) / v.totalUsd) * 100;
  return (
    `Llevas ${Math.round(idleMin)} min sin operar, con el ${Math.round(cashPct)} % en efectivo, y te falta un +${needPct.toFixed(0)} % con ${Math.round(secondsLeft / 60)} min por delante. ` +
    "Quedarte quieto garantiza no llegar: es el peor resultado. Tus creencias sirven para elegir entre candidatos, no para no operar: " +
    "si ninguno es perfecto, entra en el mejor que haya con una tesis clara (y, si lleva una creencia negativa fuerte, el simulador te lo dirá)."
  );
}

/**
 * Por debajo de este valor la cartera ya no puede operar de forma útil (comisiones, renta de cuentas,
 * mínimos): el 5 % del capital inicial, y nunca menos de 2 $. La misión termina "sin fondos".
 */
export function bustFloor(mission: Pick<Mission, "initial_usd">): number {
  return Math.max(2, mission.initial_usd * 0.05);
}

/** Valor por debajo del cual una misión real se para (pérdida máxima); null en simulación. */
export function lossFloor(mission: Mission): number | null {
  if (!isLive(mission) || !mission.limits) return null;
  const { maxLossPct } = JSON.parse(mission.limits) as MissionLimits;
  return mission.initial_usd * (1 - maxLossPct / 100);
}

/** Comprueba una misión y la cierra si ha llegado al objetivo o se le ha acabado el plazo. */
const lastSync = new Map<number, number>();

async function checkOne(mission: Mission): Promise<string[]> {
  const expired = remaining(mission.deadline).ms <= 0;
  // Misión real: los saldos se leen de la cadena (como mucho cada 20 s por proceso).
  if (isLive(mission) && (expired || Date.now() - (lastSync.get(mission.id) ?? 0) > 20_000)) {
    const { syncHoldings } = await import("../live/sync.js");
    await syncHoldings(mission.id);
    lastSync.set(mission.id, Date.now());
  }
  const v = await valuation(mission.id);
  const value = v.totalUsd;
  // Con un valor de reserva (sin cotización real) no se da el objetivo por conseguido.
  let reached = value >= mission.target_usd && v.reliable;
  // Antes de venderlo todo por haber llegado, se confirma con cotizaciones del momento: la valoración puede venir
  // de una cotización de hace unos segundos, y en un token que se mueve un 40 % por minuto ya no vale. En la M4 de
  // la v0.36.1 se dio por alcanzado con 57,46 $, la venta dio 47,46 y se llevó por delante la toma de beneficio.
  if (reached && remaining(mission.deadline).ms > 0 && !isLive(mission)) {
    const fresh = await valuation(mission.id, false, { fresh: true });
    reached = fresh.totalUsd >= mission.target_usd && fresh.reliable;
    if (!reached) return [];
  }
  // Misión real: al llegar a la pérdida máxima se para sola (se vende a estables y se cierra).
  const floor = lossFloor(mission);
  const lossHit = !reached && floor !== null && v.reliable && value < floor;
  // Sin fondos: lo que queda no da para operar (comisiones, renta de cuentas). La misión ha muerto.
  const bust = !reached && v.reliable && value < bustFloor(mission);
  if (!expired && !reached && !lossHit && !bust) return [];

  // Reclamo atómico: solo un proceso cierra la misión.
  const status = reached ? "succeeded" : bust ? "bust" : "expired";
  if (!db.prepare("UPDATE missions SET status = 'closing' WHERE id = ? AND status = 'active'").run(mission.id).changes) return [];

  const reason = reached
    ? `Cierre automático: objetivo de la misión #${mission.id} alcanzado (${value.toFixed(2)} ≥ ${mission.target_usd} USD)`
    : bust
      ? `Parada automática: la misión #${mission.id} se ha quedado sin fondos para operar (${value.toFixed(2)} USD)`
      : lossHit
        ? `Parada automática: la misión #${mission.id} ha llegado a la pérdida máxima (${value.toFixed(2)} < ${floor!.toFixed(2)} USD)`
        : `Cierre automático: se acabó el plazo de la misión #${mission.id}`;
  db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ? WHERE status = 'open' AND mission_id = ?").run(now(), mission.id);
  await settleTransfers({ missionId: mission.id, force: true });
  // Con el objetivo tocado, el nativo se vende solo si al final se cierra: si lo realizado se queda corto y la
  // misión sigue, sin él no habría gas para volver a operar (en la M1 de la v0.35 se quedó sin SOL así).
  const keepNative = reached && !expired && !isLive(mission);
  const problems = await liquidateAll(mission.id, null, reason, { keepNative });
  let final = await valuation(mission.id, true);

  // El objetivo se detecta con el valor de liquidación estimado, pero lo que cuenta es lo
  // realizado al vender: el efectivo en stablecoins. Si al cerrar se queda corto y aún hay tiempo,
  // la misión continúa y se reintenta. Lo que no se pudo vender (p. ej. un token sin ruta de venta,
  // que vale 0) no impide cerrarla si el efectivo ya llega al objetivo.
  // En una misión real, el nativo no se vende (paga la red de las siguientes): cuenta como realizado.
  const natives = new Set(allChains().map((c) => `${c.id}:${c.native.address}`));
  const realizedUsd = final.holdings
    .filter((h) => h.valuedBy === "stable" || ((isLive(mission) || keepNative) && natives.has(`${h.venue}:${h.asset}`)))
    .reduce((s, h) => s + h.usd, 0);
  const closes = !(reached && !expired && realizedUsd < mission.target_usd);
  if (keepNative && closes) {
    problems.push(...(await liquidateAll(mission.id, null, reason, { nativeOnly: true })));
    final = await valuation(mission.id, true);
  }
  if (!closes) {
    db.prepare("UPDATE missions SET status = 'active' WHERE id = ?").run(mission.id);
    const summary = problems.length
      ? `Misión #${mission.id}: objetivo alcanzado, pero no se pudo vender todo (${problems.join("; ")}). La misión continúa y se reintentará.`
      : `Misión #${mission.id}: al cerrar posiciones el resultado realizado (${final.totalUsd.toFixed(2)} USD) quedó por debajo ` +
        `del objetivo (${mission.target_usd} USD) por comisiones y slippage. La misión continúa.`;
    logJournal({ missionId: mission.id, sessionId: null, kind: "mission", summary, details: { problems } });
    return [summary];
  }

  db.prepare("UPDATE missions SET status = ?, ended_at = ?, final_usd = ? WHERE id = ?").run(status, now(), final.totalUsd, mission.id);
  const summary =
    `Misión #${mission.id} ${reached ? "CONSEGUIDA" : bust ? "SIN FONDOS (bancarrota)" : lossHit ? "PARADA POR PÉRDIDA MÁXIMA" : "TERMINADA POR TIEMPO"}: ${mission.initial_usd.toFixed(2)} → ${final.totalUsd.toFixed(2)} USD ` +
    `(objetivo ${mission.target_usd} USD)`;
  logJournal({ missionId: mission.id, sessionId: null, kind: "mission", summary, details: { problems } });
  return [summary, ...problems.map((p) => `No se pudo liquidar: ${p}`)];
}

const checking = new Set<number>();

/**
 * Comprueba las misiones activas y cierra las que
 * hayan terminado. Devuelve líneas de log. Si se indica una misión, solo comprueba esa.
 */
export async function checkMission(missionId?: number): Promise<string[]> {
  const targets = missionId !== undefined ? [getMission(missionId)].filter((m): m is Mission => m?.status === "active") : activeMissions();
  const results = await Promise.all(
    targets.map(async (m) => {
      if (checking.has(m.id)) return [];
      checking.add(m.id);
      try {
        return await checkOne(m);
      } catch (err) {
        return [`Error revisando la misión #${m.id}: ${(err as Error).message}`];
      } finally {
        checking.delete(m.id);
      }
    }),
  );
  return results.flat();
}
