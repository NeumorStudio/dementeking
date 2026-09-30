import { readFileSync } from "node:fs";
import { z } from "zod";
import { db, logActivity, logJournal, now } from "../db.js";
import { fetchText } from "../market/http.js";
import { CHAINS, VENUES, type ChainId, type Features } from "../sim/types.js";
import { getChain } from "../sim/venues/index.js";
import type { TokenRef } from "../sim/venues/types.js";
import * as mission from "../sim/mission.js";
import * as memory from "../sim/memory.js";
import * as orders from "../sim/orders.js";
import * as positions from "../sim/positions.js";
import * as sim from "../sim/portfolio.js";
import * as transfers from "../sim/transfers.js";
import { estimateTokenLaunch } from "../sim/launch.js";
import { checkBuyAgainstMemory, memoryBlockers } from "../sim/guard.js";
import { buyEntry, entryExclusion, excludedTokens, placeExits, prepareEntry } from "../sim/entry.js";
import { ENTRY_SLIPPAGE_BPS, entrySlippageBps } from "../sim/mission-kind.js";
import * as plans from "../sim/plans.js";
import { DEFAULT_MAX_ROUND_TRIP_COST_PCT, describeSourceErrors, waitForSignal } from "../sim/signals.js";
import { baselineForClass } from "../sim/baselines.js";
import { asset } from "../paths.js";
import { AGENTS, json, MARKET_READERS, OPERATORS, tool, type EntryResult, type ToolCtx, type ToolOutput } from "./define.js";
import { toText } from "./format.js";
import { recordFeatures, recordRead, recordScan } from "../sim/market-state.js";
import { WAIT_MIN_MINUTES, waitTiming, watchTick } from "../sim/watch.js";

/** Misión del contexto; las herramientas que la necesitan solo se ejecutan si existe. */
const mid = (ctx: ToolCtx): number => {
  if (ctx.missionId === null) throw new Error("No hay ninguna misión");
  return ctx.missionId;
};

/**
 * En una misión rápida, comprar un token fuera de enter_with_exits (simulate_swap, o una orden condicional que compra) sigue
 * las reglas de la entrada: no se compra un token descartado (su compra revirtió porque el precio se movió más que el
 * slippage) ni con más slippage que el de la entrada (el del plan o ENTRY_SLIPPAGE_BPS). En la M18 se forzó una entrada
 * subiendo el slippage al 25 % y el token cayó un 79 %: con el reloj en marcha, simulate_swap permitía repetirlo. Vender
 * (a efectivo o al nativo de la cadena) no tiene tope.
 */
async function checkFastBuy(a: { missionId: number; chain: ChainId; output: string; slippageBps: number; via: string }) {
  const m = mission.getMission(a.missionId);
  if (!m || !mission.isFastMission(m)) return;
  const chain = getChain(a.chain);
  const token = await chain.resolveToken(a.output);
  if (chain.isCash(token.address) || token.address === chain.native.address) return;
  const excluded = entryExclusion(a.missionId, token.address);
  if (excluded) {
    throw new Error(
      `${token.symbol} está descartado en esta misión (${excluded.reason}): no se compra, ni con enter_with_exits ni con ${a.via}. ` +
        "Espera al siguiente candidato con wait_for_signal",
    );
  }
  const plan = plans.planForMission(a.missionId);
  const max = entrySlippageBps(plan);
  if (a.slippageBps > max) {
    const from = plan?.body.slippage_bps !== undefined ? `el del plan #${plan.id}` : "el de por defecto";
    throw new Error(
      `slippage_bps ${a.slippageBps} pasa del tope de ${max} para comprar un token en una misión rápida (${from}, el mismo que en enter_with_exits): ` +
        "una compra no se fuerza subiendo el slippage. Si revierte, el precio se está moviendo en tu contra más de lo que admite el plan, y eso es " +
        "justo de lo que protege la reversión",
    );
  }
}


// Las esperas no pasan de 4,5 minutos: la caché de prompts de los subagentes dura 5, y una espera más
// larga hace que el turno siguiente relea todo el contexto sin caché (a precio completo).
const MAX_WAIT_MINUTES = 4.5;

/** Capital con el que wait_for_signal cotiza la ida y vuelta si no hay misión ni plan que lo digan: el de la misión rápida por defecto. */
const DEFAULT_SIGNAL_USD = 50;

/** Respuesta a cualquier operación antes de arrancar el reloj de la misión (runTool). */
export const CLOCK_NOT_STARTED = "Arranca el reloj con start_session antes de operar";

/** `wait` no repite la vuelta de vigilancia si alguien hizo una hace menos de esto (menos que su sondeo de 5 s). */
const WAIT_FRESH_TICK_MS = 4_000;

const FIELD_GUIDE = asset("guia-del-terreno.md", "knowledge/guia-del-terreno.md");

const reasoning = z.string().describe("Por qué haces esto. Queda en el diario.");

const chainParam = z.enum(CHAINS as [ChainId, ...ChainId[]]).describe("Cadena en la que operas o investigas");

// Condición de una creencia sobre los datos de entrada de las posiciones.
const conditionSchema = z
  .object({
    all: z
      .array(
        z.object({
          f: z.enum(memory.CONDITION_FIELDS),
          op: z.enum(memory.CONDITION_OPS),
          v: z.union([z.number(), z.string(), z.boolean()]),
        }),
      )
      .min(1),
  })
  .describe('Todas las cláusulas deben cumplirse. Ejemplo: {"all":[{"f":"ageMinutes","op":"<","v":30},{"f":"organicScore","op":">=","v":50}]}');

// Alias de tokens que entiende cada cadena, para las descripciones.
const TOKEN_ALIASES = "en Solana: SOL y USDC; en Base: ETH, WETH y USDC; en BNB Chain (bsc): BNB, WBNB, USDT y USDC";

// Tesis obligatoria en cada operación de trading: obliga a argumentar con pruebas y fuentes.
const thesis = z
  .object({
    why: z.string().min(1).describe("Por qué esta operación y por qué ahora"),
    evidence: z.string().min(1).describe("Datos concretos comprobados que la respaldan (no solo que el precio se mueve)"),
    sources: z.array(z.string().min(1)).min(1).describe("URLs o APIs consultadas"),
    exit_plan: z.string().min(1).describe("Cuándo cerrarías con beneficio y cuándo la darías por fallida (en una venta: qué harás después)"),
    beliefs_applied: z.array(z.number().int()).describe("Ids de las creencias que aplicas (vacío si ninguna); el simulador mide cómo le va a cada una"),
    memory_note: z.string().min(1).describe("Cómo aplicas tu memoria (creencias, howtos, briefing) o por qué no aplica"),
    risks_checked: z
      .string()
      .optional()
      .describe("Obligatorio al comprar un token: qué has comprobado en contra (creencias negativas, datos de riskCheck) y por qué no la descartan"),
    overrides: z
      .array(z.object({ id: z.number().int(), reason: z.string().min(10) }))
      .optional()
      .describe("Solo si el simulador rechazó la compra por tu memoria: creencias que ignoras a sabiendas, con el motivo concreto; cuentan igual como evidencia"),
  })
  .describe("Tesis de la operación (queda en el diario y en el panel)");

const formatThesis = (t: z.infer<typeof thesis>) =>
  `Por qué: ${t.why}\nPruebas: ${t.evidence}\nFuentes: ${t.sources.join(" · ")}\nPlan: ${t.exit_plan}\nMemoria: ${t.beliefs_applied.length ? `creencias #${t.beliefs_applied.join(", #")}. ` : ""}${t.memory_note}` +
  (t.risks_checked ? `\nRiesgos comprobados: ${t.risks_checked}` : "") +
  (t.overrides?.length ? `\nIgnora a sabiendas: ${t.overrides.map((o) => `#${o.id} (${o.reason})`).join("; ")}` : "");

const tradeMeta = (t: z.infer<typeof thesis>) => ({ thesis: formatThesis(t), lessonsApplied: t.memory_note, beliefsApplied: t.beliefs_applied });

// Tesis abreviada: en una misión rápida (15 min o menos) cada operación puede citar el plan del cerebro en lugar de
// escribir la tesis entera, que costaba 1.000-1.300 tokens por decisión con el reloj corriendo. Queda la del plan.
const planThesis = z
  .object({
    plan_ref: z.number().int().describe("Id del plan vigente (get_plan): la tesis, con su risks_checked, se toma del plan"),
    overrides: thesis.shape.overrides,
  })
  .describe("Solo en misiones rápidas (15 min o menos): en lugar de la tesis completa, el plan del cerebro");

const thesisParam = z.union([thesis, planThesis]);

/** La tesis completa de una operación: la escrita o, con plan_ref, la del plan (solo en misiones rápidas). */
function fullThesis(t: z.infer<typeof thesisParam>, ctx: ToolCtx): z.infer<typeof thesis> {
  if (!("plan_ref" in t)) return t;
  const fromPlan = plans.thesisFromPlan(t.plan_ref, mid(ctx));
  // Las creencias que el revisor haya retirado desde que se escribió el plan ya no cuentan como aplicadas.
  const gone = fromPlan.beliefs_applied.length ? memory.unknownBeliefs(fromPlan.beliefs_applied) : [];
  return { ...fromPlan, beliefs_applied: fromPlan.beliefs_applied.filter((id) => !gone.includes(id)), ...(t.overrides ? { overrides: t.overrides } : {}) };
}


// ─── Chequeo de riesgo de token_report ──────────────────────────────────────

/** Última lectura de cada token (en este proceso), para decir qué ha cambiado en la siguiente. */
const lastReads = new Map<string, { at: number; f: Features }>();

/**
 * Datos de riesgo del token y de su creador, sin juicio: qué significan lo decide la memoria del agente
 * (creencias con condición sobre estos mismos campos). Antes eran "alarmas" puestas por nosotros, y los
 * datos del agente llegaron a desmentir alguna (creadores en serie: 10 de 11 ganadas).
 */
function riskCheck(chain: ChainId, token: string, f: Features) {
  const key = `${chain}:${token.toLowerCase()}`;
  const prev = lastReads.get(key);
  lastReads.set(key, { at: Date.now(), f });
  recordRead(chain, token, { liquidityUsd: f.liquidityUsd, netBuyers5m: f.netBuyers5m });
  recordFeatures(chain, token, f as unknown as Record<string, unknown>);
  const change = (a?: number, b?: number) => (a !== undefined && b !== undefined && a !== 0 ? Number((((b - a) / Math.abs(a)) * 100).toFixed(1)) : undefined);
  return {
    creator: f.creator,
    creatorTokens: f.creatorTokens,
    creatorGraduated: f.creatorGraduated,
    ...positions.creatorHistory(f.creator),
    devHoldingPct: f.devHoldingPct,
    creatorHoneypots: f.creatorHoneypots,
    insidersDetected: f.insidersDetected,
    lpLockedPct: f.lpLockedPct,
    launchpad: f.launchpad,
    honeypot: f.honeypot,
    mcapToLiquidity: f.mcapUsd !== undefined && f.liquidityUsd ? Number((f.mcapUsd / f.liquidityUsd).toFixed(2)) : undefined,
    ...(prev
      ? {
          sinceLastRead: {
            minutesAgo: Number(((Date.now() - prev.at) / 60_000).toFixed(1)),
            liquidityChangePct: change(prev.f.liquidityUsd, f.liquidityUsd),
            mcapChangePct: change(prev.f.mcapUsd, f.mcapUsd),
            holders: prev.f.holders !== undefined && f.holders !== undefined ? `${prev.f.holders} → ${f.holders}` : undefined,
            netBuyers5m: prev.f.netBuyers5m !== undefined && f.netBuyers5m !== undefined ? `${prev.f.netBuyers5m} → ${f.netBuyers5m}` : undefined,
          },
        }
      : { sinceLastRead: "primera lectura" }),
  };
}

/** Los datos de riesgo en una celda de tabla (escaneo y fichas breves): solo los que hay, sin juicio. */
function riskCell(rc: ReturnType<typeof riskCheck>): string {
  return [
    rc.creatorTokens !== undefined ? `creador ${rc.creatorTokens} tokens/${rc.creatorGraduated ?? 0} graduados` : "",
    rc.creatorTradesWithYou ? `le operaste ${rc.creatorTradesWithYou} (peor ${rc.creatorWorstPnlWithYouPct} %)` : "",
    rc.devHoldingPct !== undefined ? `dev ${rc.devHoldingPct} %` : "",
    rc.insidersDetected !== undefined ? `insiders ${rc.insidersDetected}` : "",
    rc.lpLockedPct !== undefined ? `LP bloqueada ${rc.lpLockedPct} %` : "",
    rc.creatorHoneypots ? "creador con otros honeypots" : "",
    rc.honeypot !== undefined ? `honeypot ${rc.honeypot ? "sí" : "no"}` : "",
    rc.mcapToLiquidity !== undefined ? `mcap/liq ${rc.mcapToLiquidity}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ─── Respuestas de investigación compactas ─────────────────────────────────
// scan_market y token_report son lo que más contexto llena en una misión: se quitan repeticiones.

const SOURCE_CODE: Record<string, string> = {
  jupiter_trending_5m: "jup5m",
  jupiter_trending_1h: "jup1h",
  pumpfun_live: "pump",
  dexscreener_boosted: "dexBoost",
  dexscreener_profiles: "dexNew",
  geckoterminal_trending: "gecko",
  geckoterminal_trending_pools: "gecko",
  geckoterminal_new_pools: "geckoNew",
};

/** Fuentes abreviadas y nombre solo si aporta algo distinto del símbolo. */
export function compactScan(scan: unknown) {
  if (!scan || typeof scan !== "object" || !Array.isArray((scan as { candidates?: unknown }).candidates)) return scan;
  const s = scan as { candidates: Array<Record<string, unknown>>; newest?: Array<Record<string, unknown>> };
  const row = ({ sources, name, symbol, ...c }: Record<string, unknown>) => {
      // GeckoTerminal da el nombre del par ("CATE / SOL"): tampoco aporta nada.
      const n = typeof name === "string" ? name.trim().toLowerCase().replace(/ \/ \S+$/, "") : "";
      const same = typeof symbol === "string" && n === symbol.trim().toLowerCase();
      return {
        ...Object.fromEntries(Object.entries(c).slice(0, 1)),
        symbol,
        ...(same || !name ? {} : { name: String(name).slice(0, 24) }),
        sources: Array.isArray(sources) ? sources.map((x) => SOURCE_CODE[x] ?? x).join(",") : sources,
        ...Object.fromEntries(Object.entries(c).slice(1)),
      };
  };
  return {
    ...s,
    sourcesStatus: undefined,
    sourceCodes:
      "jup5m/jup1h: tendencia en Jupiter 5 min/1 h · pump: en directo en pump.fun · dexBoost: promocionado en DexScreener · " +
      "dexNew: perfil recién creado en DexScreener · gecko/geckoNew: GeckoTerminal tendencia/nuevos",
    candidates: s.candidates.map(row),
    ...(s.newest?.length ? { newest: s.newest.map(row), newestNote: "Los de menos de 60 min que no entran en la lista (salen en pocas fuentes)" } : {}),
  };
}

// ─── Espera con novedades ──────────────────────────────────────────────────

type Valuation = Awaited<ReturnType<typeof sim.valuation>>;

/** Valor de cada posición con riesgo (tokens que no son estables y futuros), por clave estable. */
export function positionValues(v: Valuation | null): Map<string, { position: string; usd: number }> | null {
  if (!v) return null;
  const out = new Map<string, { position: string; usd: number }>();
  for (const h of v.holdings as Array<{ venue: string; asset: string; symbol: string; usd?: number; valuedBy?: string }>) {
    if (h.valuedBy === "stable" || (h.usd ?? 0) < 0.5) continue;
    out.set(`${h.venue}:${h.asset}`, { position: `${h.symbol} (${h.venue})`, usd: h.usd ?? 0 });
  }
  for (const p of v.perps ?? []) out.set(`perp:${p.perpId}`, { position: p.position, usd: p.valueIfClosedUsd });
  return out;
}

/** Cómo se ha movido cada posición entre dos momentos (las nuevas y las cerradas también salen). */
export function movesSince(base: Map<string, { position: string; usd: number }> | null, now: Map<string, { position: string; usd: number }> | null) {
  const a = base ?? new Map(), b = now ?? new Map();
  return [...new Set([...a.keys(), ...b.keys()])].map((k) => {
    const from = a.get(k)?.usd ?? 0, to = b.get(k)?.usd ?? 0;
    return {
      position: (b.get(k) ?? a.get(k))!.position,
      startUsd: from,
      nowUsd: to,
      changePct: from > 0 ? Number((((to - from) / from) * 100).toFixed(1)) : 0,
      ...(from === 0 ? { note: "nueva" } : to === 0 ? { note: "cerrada o sin valor" } : {}),
    };
  });
}

/** Ejecuta fn sobre la lista con como mucho `limit` llamadas a la vez (las APIs de riesgo limitan ráfagas). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Lo que dice la memoria de un token, en una celda: "frena #10 · avisa #23 · apoya #16". */
function memoryCell(chain: ChainId, f: Features, address: string, missionId: number | null = null): string {
  // Con la misión, también cuentan las creencias sobre cómo decide: si ya operó este token y cuánto queda.
  const decision = missionId !== null ? positions.decisionContext(missionId, chain, address, 0, false) : {};
  const entry = { ...f, ...positions.creatorHistory(f.creator) } as unknown as Record<string, unknown>;
  const m = memory.beliefsFor(chain, entry, address, decision);
  // Cada creencia con su evidencia al lado: "(2 a favor/1 en contra, hipótesis)". Menos de 10 casos es una
  // hipótesis que puede ser suerte, no un filtro.
  const ids = (list: number[]) =>
    list
      .map((id) => {
        const c = m.cases[id];
        return c ? `#${id} (${c.inFavor} a favor/${c.against} en contra${c.stage === "hypothesis" ? ", hipótesis" : c.stage === "provisional" ? ", provisional" : ""})` : `#${id}`;
      })
      .join(", ");
  return [
    ...(m.block.length ? [`frena #${m.block.join(", #")}`] : []),
    ...(m.caution.length ? [`avisa ${ids(m.caution)}`] : []),
    ...(m.favor.length ? [`apoya ${ids(m.favor)}`] : []),
  ].join(" · ");
}

/**
 * Chequeo previo de los primeros candidatos de un escaneo, dentro de la misma llamada: sus datos de
 * riesgo y qué dice la memoria. Ahorra una ronda de token_report por candidato solo para descartarlo.
 * Cuenta como primera lectura: el siguiente token_report de ese token trae sinceLastRead.
 */
export async function screenCandidates(chain: ChainId, candidates: Array<Record<string, unknown>>, n: number, missionId: number | null = null): Promise<Array<Record<string, unknown>>> {
  const c = getChain(chain);
  const checked = await mapLimit(candidates.slice(0, n), 3, async (cand) => {
    const address = String(cand.mint ?? cand.token ?? "");
    const f = address ? await c.entryFeatures(address).catch(() => null) : null;
    if (!f) return { ...cand, risk: "sin datos" };
    const rc = riskCheck(chain, address, f);
    return { ...cand, risk: riskCell(rc), memory: memoryCell(chain, f, address, missionId), yourHistory: positions.tokenHistory(chain, address) };
  });
  return [...checked, ...candidates.slice(n)];
}

/** Fichas breves de varios tokens en una tabla, con los mismos datos en todas las cadenas (los de entrada). */
export async function briefReports(chain: ChainId, tokens: string[], missionId: number | null = null): Promise<string> {
  const c = getChain(chain);
  const rows = await mapLimit([...new Set(tokens.map((t) => t.trim()))], 3, async (token) => {
    const t = await c.resolveToken(token).catch(() => null);
    const f = t ? await c.entryFeatures(t.address).catch(() => null) : null;
    if (!t || !f) return { token, symbol: t?.symbol, error: "sin datos (dirección desconocida o APIs caídas)" };
    const rc = riskCheck(chain, token, f);
    const since = rc.sinceLastRead;
    return {
      token,
      symbol: t.symbol,
      ageMinutes: f.ageMinutes,
      liquidityUsd: f.liquidityUsd,
      mcapUsd: f.mcapUsd,
      priceChange5mPct: f.priceChange5mPct,
      priceChange1hPct: f.priceChange1hPct,
      netBuyers5m: f.netBuyers5m,
      buySellRatio5m: f.buySellRatio5m,
      holders: f.holders,
      topHoldersPct: f.topHoldersPct,
      taxes: f.buyTaxPct !== undefined || f.sellTaxPct !== undefined ? `${f.buyTaxPct ?? "?"}/${f.sellTaxPct ?? "?"} %` : undefined,
      launchpad: f.launchpad,
      risk: riskCell(rc),
      memory: memoryCell(chain, f, t.address, missionId),
      yourHistory: positions.tokenHistory(chain, t.address) ?? "nunca",
      sinceLastRead:
        typeof since === "string"
          ? "primera lectura"
          : [
              `hace ${since.minutesAgo} min`,
              since.liquidityChangePct !== undefined ? `liq ${since.liquidityChangePct > 0 ? "+" : ""}${since.liquidityChangePct} %` : "",
              since.mcapChangePct !== undefined ? `mcap ${since.mcapChangePct > 0 ? "+" : ""}${since.mcapChangePct} %` : "",
              since.netBuyers5m ? `compradores ${since.netBuyers5m}` : "",
            ]
              .filter(Boolean)
              .join(", "),
    };
  });
  return toText({
    note: "Fichas breves. La completa de uno (actividad por tramos, webs y redes, auditoría detallada): token_report con token. memory = ids de creencias de tu resumen.",
    tokens: rows,
  });
}

/**
 * Coste de comprar y vender al momento (spread, comisiones e impacto) con 25 $ de un estable: lo que el precio
 * tiene que subir solo para quedarse igual. Se descubría después de comprar; así está antes de decidir.
 */
async function roundTripCost(chain: ChainId, token: TokenRef) {
  const c = getChain(chain);
  const stable = c.stables[0];
  if (!stable || c.isCash(token.address)) return undefined;
  const usd = 25;
  const buy = await c.quote({ input: stable, output: token, amountIn: usd, slippageBps: 300 });
  if (!(buy.amountOut > 0)) return undefined;
  const sell = await c.quote({ input: token, output: stable, amountIn: buy.amountOut, slippageBps: 300 });
  return { withUsd: usd, backUsd: Number(sell.amountOut.toFixed(2)), costPct: Number(((1 - sell.amountOut / usd) * 100).toFixed(2)) };
}

/** token_report sin lo que ya sabe el agente (la dirección que ha pedido) ni lo que no sirve para decidir. */
export function compactReport(report: unknown): Record<string, unknown> {
  const r = { ...(report as Record<string, unknown>) };
  delete r.mint;
  if (r.token && typeof r.token === "object") {
    const { address: _a, ...token } = r.token as Record<string, unknown>;
    r.token = token;
  }
  const pump = r.pumpfun as Record<string, unknown> | undefined;
  if (pump && typeof pump === "object") {
    const verdict = (pump.securityVerdict as { verdict?: string } | undefined)?.verdict;
    const { securityVerdict: _v, url: _u, ...rest } = pump;
    r.pumpfun = { ...rest, ...(verdict ? { securityVerdict: verdict } : {}) };
  }
  return r;
}

/**
 * La guía del terreno por partes: sin secciones, la introducción y el índice (con la primera línea de
 * cada sección); con secciones, solo esas. Leerla entera eran ~4.400 tokens que se arrastraban toda la misión.
 */
export function fieldGuide(text: string, sections?: number[]): string {
  const parts = text.split(/^(?=## \d+\.)/m);
  const intro = parts[0]!.trim();
  const byNumber = new Map(parts.slice(1).map((p) => [Number(p.match(/^## (\d+)\./)![1]), p.trim()]));
  if (sections?.length) {
    const found = sections.map((n) => byNumber.get(n) ?? `## ${n}. (no existe esta sección)`);
    return found.join("\n\n");
  }
  const index = [...byNumber.entries()].map(([n, p]) => {
    const [title, ...body] = p.split("\n");
    const first = body.find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
    return `${title!.replace(/^## /, "")}: ${first.length > 160 ? first.slice(0, 160) + "…" : first}`;
  });
  return `${intro}\n\nÍndice (pide el texto con field_guide y sections, p. ej. sections: [1, 5]):\n${index.join("\n")}`;
}

// Herramientas del simulador: las comparten el runner por API y el servidor MCP.
export const SIM_TOOLS = [
  tool({
    name: "scan_market",
    kind: "research",
    role: MARKET_READERS,
    deliversNews: true,
    researchTarget: () => undefined,
    description:
      "Escaneo de mercado de una cadena en una sola llamada, con los datos clave de cada candidato (capitalización, liquidez, " +
      "variación de precio, compradores netos, antigüedad). Los que aparecen en más fuentes van primero. En Solana combina los tokens en " +
      "tendencia de Jupiter (5 min y 1 h), los que están en directo en pump.fun, los promocionados en DexScreener y las tendencias de GeckoTerminal.",
    schema: z.object({
      chain: chainParam,
      limit: z.number().int().min(5).max(60).default(15),
      check_top: z
        .number()
        .int()
        .min(0)
        .max(8)
        .default(5)
        .describe("A los N primeros les añade los datos de riesgo (los de riskCheck) y tu memoria (creencias que frenan, avisan o apoyan). 0 = no"),
    }),
    run: async ({ chain, limit, check_top }, ctx) => {
      const scan = compactScan(await getChain(chain).research.scan(limit)) as { candidates?: Array<Record<string, unknown>> };
      // Actividad del mercado (siempre sobre los 15 primeros, para que sea comparable entre escaneos).
      if (Array.isArray(scan.candidates)) recordScan(chain, scan.candidates.slice(0, 15));
      if (check_top && Array.isArray(scan.candidates)) scan.candidates = await screenCandidates(chain, scan.candidates, check_top, ctx.missionId);
      return toText(scan);
    },
  }),
  tool({
    name: "token_report",
    kind: "research",
    role: MARKET_READERS,
    deliversNews: true,
    researchTarget: (i) => (i.tokens?.length ? i.tokens : i.token),
    description:
      "Con tokens (hasta 5), una ficha breve de cada uno en una tabla, para comparar o releerlos de una vez: liquidez, mcap, " +
      "variación, compradores, holders, impuestos, datos de riesgo, qué dice tu memoria y qué ha cambiado desde la última lectura. " +
      "Con token, la ficha completa en una sola llamada: actividad de compras y ventas (5 min, 1 h, 24 h), holders, liquidez, " +
      "auditoría y riesgos, webs y redes sociales del proyecto. En Solana incluye las autoridades de mint y freeze, el % del creador y de " +
      "los mayores holders, los riesgos de RugCheck y, si es de pump.fun, su descripción, comentarios y máximo histórico. " +
      "Siempre añade `riskCheck`, solo datos: el creador (tokens lanzados y graduados, y los suyos que has operado tú), lo que conserva, " +
      "insiders, liquidez bloqueada, launchpad, honeypot y mcap/liquidez. Si repites token_report sobre el mismo token, `sinceLastRead` " +
      "dice qué ha cambiado desde la lectura anterior (liquidez, precio, compradores).",
    schema: z.object({
      chain: chainParam,
      token: z.string().optional().describe("Dirección del token (en Solana, su mint): ficha completa"),
      tokens: z.array(z.string()).min(1).max(5).optional().describe("Varias direcciones: ficha breve de cada una"),
    }),
    run: async ({ chain, token, tokens }, ctx) => {
      if (tokens?.length) return briefReports(chain, tokens, ctx.missionId);
      if (!token) throw new Error("Indica token (ficha completa) o tokens (fichas breves de varios)");
      const c = getChain(chain);
      const [report, features] = await Promise.all([c.research.report(token.trim()), c.resolveToken(token.trim()).then((t) => c.entryFeatures(t.address)).catch(() => null)]);
      const resolved = await c.resolveToken(token.trim()).catch(() => null);
      const history = resolved ? positions.tokenHistory(chain, resolved.address) : undefined;
      const roundTrip = resolved ? await roundTripCost(chain, resolved).catch(() => undefined) : undefined;
      return json({
        ...compactReport(report),
        ...(features ? { riskCheck: riskCheck(chain, token.trim(), features) } : {}),
        yourHistory: history ?? "nunca lo has operado",
        ...(roundTrip ? { roundTrip } : {}),
      });
    },
  }),
  tool({
    name: "strategy_fit",
    kind: "research",
    role: AGENTS,
    researchTarget: () => undefined,
    description:
      "Encaje de estrategias con la misión: con lo que te falta para el objetivo y el tiempo que queda, la probabilidad estimada de " +
      "llegar con cada estrategia (memecoins según las líneas base medidas y tu historial, cripto grande al contado, futuros: estos, llegar " +
      "ANTES de liquidarse) y su riesgo de ruina. Trae la frontera: en cada plazo medido (5/10/15/30 min), el objetivo más alto con P ≥10, " +
      "≥25 y ≥50 %. Con duration_minutes y target_pct (o market), solo la tabla medida para esa clase de misión, sin mirar ninguna cartera " +
      "(la P base de mercado × plazo × objetivo, la misma casilla en los otros mercados y lo medido con futuros): sirve antes de crear la misión.",
    schema: z.object({
      market: z
        .string()
        .regex(/^[a-z0-9_]+$/)
        .optional()
        .describe("Mercado de la clase: graduado (por defecto), momentum o lanzamiento son los medidos"),
      duration_minutes: z.number().positive().optional().describe("Plazo de la clase (por defecto, el de la misión)"),
      target_pct: z.number().positive().optional().describe("Objetivo de la clase en % (por defecto, el de la misión)"),
    }),
    run: async (i, ctx) => {
      const { strategyFit, tableFit } = await import("../sim/fit.js");
      if ((i.duration_minutes === undefined) !== (i.target_pct === undefined)) {
        throw new Error("Indica duration_minutes y target_pct juntos (o ninguno, para los de la misión)");
      }
      const m = ctx.missionId !== null ? mission.getMission(ctx.missionId) : undefined;
      // Sin misión o preguntando por una clase: la tabla medida, sin cartera.
      if (!m || i.duration_minutes !== undefined || i.market) {
        return toText(
          tableFit({
            market: i.market,
            minutes: i.duration_minutes ?? (m ? mission.missionDurationMinutes(m) : undefined),
            targetPct: i.target_pct ?? (m ? ((m.target_usd - m.initial_usd) / m.initial_usd) * 100 : undefined),
          }),
        );
      }
      return toText(await strategyFit(m));
    },
  }),
  tool({
    name: "field_guide",
    kind: "research",
    role: AGENTS,
    description:
      "Guía del terreno: qué mercados puede ejecutar el simulador y cómo los simula, cómo funciona pump.fun " +
      "(curva, comisiones, graduación) y qué APIs públicas de datos responden, con sus URLs y campos. Hechos, no recomendaciones. " +
      "Sin sections, el índice; con sections, el texto de esas secciones.",
    schema: z.object({ sections: z.array(z.number().int().min(1).max(20)).optional().describe("Números de sección que quieres leer") }),
    run: async ({ sections }) => fieldGuide(readFileSync(FIELD_GUIDE, "utf8"), sections),
  }),
  tool({
    name: "log_progress",
    kind: "misc",
    journaled: true,
    description:
      "Registro de trabajo: anota qué vas a investigar o hacer a continuación, qué has encontrado y qué decisiones tomas. " +
      "Se muestra en el panel del usuario.",
    schema: z.object({ entry: z.string() }),
    run: async ({ entry }, ctx) => {
      logActivity({ missionId: ctx.missionId, sessionId: ctx.sessionId, kind: "thought", title: entry });
      return "Anotado.";
    },
  }),
  tool({
    name: "mission_status",
    kind: "misc",
    role: MARKET_READERS,
    // Sin novedades del briefing: también la usa la sesión del usuario para ver si la misión sigue, y se las
    // quedaba (marcándolas como vistas) antes de que llegaran al trader. Le llegan con el resto de sus herramientas.
    description:
      "Estado de tu misión: capital inicial, objetivo, valor actual de la cartera, cuánto falta y tiempo restante. " +
      "La misión termina sola al alcanzar el objetivo o al acabarse el plazo; entonces se cierran todas las posiciones a mercado.",
    schema: z.object({}),
    run: async (_i, ctx) => json(await mission.missionStatus(ctx.missionId ?? undefined)),
  }),
  tool({
    name: "wait",
    kind: "misc",
    deliversNews: true,
    description:
      `Deja pasar tiempo real (1-${MAX_WAIT_MINUTES} minutos; en una misión de ${mission.FAST_MISSION_MAX_MINUTES} min o menos, desde ${String(WAIT_MIN_MINUTES).replace(".", ",")}) ` +
      "vigilando tu cartera. Vuelve antes si la misión termina, si pasa algo " +
      "(se dispara una orden, llega una transferencia, un futuro se cierra) o si una posición se mueve wake_on_move_pct o más. " +
      "Devuelve solo lo que ha cambiado: las novedades, cómo se han movido tus posiciones y el estado de la misión (no hace falta " +
      "pedir portfolio ni mission_status después). El tiempo también pasa mientras investigas u operas.",
    schema: z.object({
      minutes: z.number().min(WAIT_MIN_MINUTES).max(MAX_WAIT_MINUTES),
      wake_on_move_pct: z.number().min(3).max(100).default(15).describe("Vuelve antes si una posición sube o baja este % desde que empezaste a esperar"),
    }),
    run: async ({ minutes: requested, wake_on_move_pct }, ctx) => {
      const m = mid(ctx);
      // En una misión rápida se mira cada 5 s y se admiten esperas de 15 s; en una larga, desde 1 min y cada 20 s.
      const row = mission.getMission(m);
      const timing = waitTiming(requested, !!row && mission.isShortMission(row));
      const pollMs = timing.pollMs;
      let minutes = timing.minutes;
      // Parado en efectivo y lejos del objetivo: no se deja pasar más de un minuto seguido.
      const before = await mission.missionStatus(m);
      const idle = "warning" in before && before.warning;
      if (idle) minutes = Math.min(minutes, 1);
      const started = Date.now();
      const startIso = now();
      const until = started + minutes * 60_000;
      const base = positionValues(await sim.valuation(m));
      let current = base;
      let wake = "";
      while (Date.now() < until && !wake) {
        await new Promise((r) => setTimeout(r, Math.min(pollMs, until - Date.now())));
        // La misma vuelta que la vigilancia de fondo; si otro proceso acaba de hacerla, no se repite (Jupiter).
        await watchTick({ skipIfFresherMs: WAIT_FRESH_TICK_MS });
        if (mission.getMission(m)?.status !== "active") wake = "la misión ha terminado";
        else if ((db.prepare("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND ts > ?").get(m, startIso) as { n: number }).n) wake = "hay novedades";
        else {
          current = positionValues(await sim.valuation(m).catch(() => null)) ?? current;
          const moved = movesSince(base, current).find((x) => Math.abs(x.changePct) >= wake_on_move_pct);
          if (moved) wake = `${moved.position} se ha movido un ${moved.changePct > 0 ? "+" : ""}${moved.changePct} %`;
        }
      }
      if (mission.getMission(m)?.status === "active") current = positionValues(await sim.valuation(m).catch(() => null)) ?? current;
      const elapsed = Number(((Date.now() - started) / 60_000).toFixed(1));
      const news = db.prepare("SELECT ts, kind, summary FROM journal WHERE mission_id = ? AND ts > ? ORDER BY id").all(m, startIso) as Array<{ ts: string; kind: string; summary: string }>;
      const moves = movesSince(base, current);
      return [
        idle ? "Espera acortada a 1 minuto: estás parado en efectivo y lejos del objetivo." : "",
        `Han pasado ${elapsed} min${wake ? ` (vuelvo antes: ${wake})` : ""}. Hora: ${now()}`,
        news.length ? `Novedades:\n${news.map((n) => `- ${n.ts.slice(11, 19)} [${n.kind}] ${n.summary}`).join("\n")}` : "Sin novedades en tus órdenes ni transferencias.",
        moves.length ? `Tus posiciones durante la espera:\n${toText(moves)}` : "",
        `Misión:\n${toText(await mission.missionStatus(m))}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  }),
  tool({
    name: "wait_for_signal",
    kind: "misc",
    description:
      `Espera sin gastar turnos (hasta ${MAX_WAIT_MINUTES} min por llamada) a la señal de entrada del plan: mira su fuente de eventos cada 5 s y ` +
      "devuelve el primer token que pasa sus filtros mecánicos y tiene cotización de compra y de venta en Jupiter, con la ida y vuelta calculada " +
      "para tu capital (por defecto, liquidez de 1.000 $ o más e ida y vuelta del 10 % o menos: fuera los pools vaciados; el plan puede cambiarlos), " +
      "y que tu memoria no frenaría al entrar. Si la fuente no responde (p. ej. GeckoTerminal con 429), lo dice. Fuente graduado (por defecto): tokens de pump.fun recién migrados a PumpSwap (pool de 2 min o menos), vistos en " +
      "GeckoTerminal, que los publica con 10-70 s de retraso; shortlist: solo la lista corta del plan, cuando se gradúa. Funciona antes de arrancar " +
      "el reloj: esperar al evento es legítimo, operar no. Sin candidato, vuelve a llamarla; con candidato, entra con enter_with_exits.",
    schema: z.object({
      plan_ref: z.number().int().optional().describe("Plan cuyos filtros aplica (por defecto, el de la misión o el vigente de su clase)"),
      source: z.enum(plans.SIGNAL_SOURCES).optional().describe("Por defecto, la del plan (o graduado)"),
      max_minutes: z.number().min(0.25).max(MAX_WAIT_MINUTES).default(MAX_WAIT_MINUTES),
      usd_amount: z.number().positive().optional().describe("Con cuánto cotizar la ida y vuelta (por defecto, el importe del plan o todo tu efectivo en Solana)"),
      exclude: z
        .array(z.string())
        .max(100)
        .optional()
        .describe("Tokens que ya has descartado: no los devuelve (los que revirtieron al comprarlos con enter_with_exits ya van descartados solos)"),
    }),
    run: async (i, ctx) => {
      const m = ctx.missionId !== null ? mission.getMission(ctx.missionId) : undefined;
      const active = m?.status === "active" ? m : undefined;
      const plan = i.plan_ref !== undefined ? plans.getPlan(i.plan_ref) : active ? plans.planForMission(active.id) : plans.latestActivePlan();
      if (i.plan_ref !== undefined && !plan) throw new Error(`No existe el plan #${i.plan_ref}`);
      const source = i.source ?? plan?.body.source ?? "graduado";
      const shortlist = plan?.body.shortlist?.map((s) => s.mint) ?? [];
      if (source === "shortlist" && !shortlist.length) throw new Error("El plan no tiene lista corta (shortlist): usa la fuente graduado");
      const cash = active ? Math.max(0, ...getChain("solana").stables.map((s) => sim.balance(active.id, "solana", s.address))) : 0;
      // Antes del reloj, la misión queda marcada con el plan con el que se prepara: si no llega ningún candidato y se
      // cancela a los 60 min, el bloque del plan lo cuenta (get_plan) y el planner puede ver que sus filtros no dejan pasar nada.
      if (active && plan && !active.started_at && plan.class === active.class) plans.markPlanForMission(active.id, plan.id);
      // Con lo que entraría enter_with_exits: el importe del plan, recortado al efectivo.
      const usdAmount = i.usd_amount ?? (cash >= 1 ? Math.min(plan?.body.usd_amount ?? cash, cash) : (plan?.body.usd_amount ?? DEFAULT_SIGNAL_USD));
      const r = await waitForSignal({
        source,
        filters: plan?.body.filters ?? {},
        shortlist,
        usdAmount,
        maxMinutes: i.max_minutes,
        // Con los que ya revirtieron al comprarlos en esta misión (entry_exclusions): no se vuelven a ofrecer.
        exclude: [...(i.exclude ?? []), ...(active ? excludedTokens(active.id) : [])],
        shouldStop: () => (active && mission.getMission(active.id)?.status !== "active" ? "la misión ya no está activa" : null),
        // Un candidato que la memoria va a rechazar al entrar no sirve: enter_with_exits lo frenaría con el evento ya pasado.
        accept: async (c) => {
          const token = await getChain("solana").resolveToken(c.token).catch(() => null);
          const blocking = token ? await memoryBlockers({ chain: "solana", token, missionId: active?.id, amountUsd: usdAmount }) : [];
          return blocking.length ? `tu memoria lo desaconseja (creencia${blocking.length > 1 ? "s" : ""} #${blocking.map((b) => b.id).join(", #")})` : null;
        },
      });
      const waited = { waitedSeconds: r.waitedSeconds, polls: r.polls };
      const sourceNote = describeSourceErrors(r.sourceErrors);
      if (!r.candidate) {
        const rejected = Object.entries(r.rejected).map(([reason, n]) => `${reason} ×${n}`).join("; ");
        const summary =
          (r.stopped ? `Espera cortada: ${r.stopped}. ` : `Sin señal en ${r.waitedSeconds} s (${r.polls} vueltas). `) +
          `Tokens frescos vistos: ${r.seen}${rejected ? `; descartes: ${rejected}` : ""}.` +
          (sourceNote ? ` ${sourceNote}` : "");
        // Antes del reloj queda en el diario de la misión: si se cancela sin candidato, el planner ve por qué (journal_history).
        if (active && !active.started_at) {
          logJournal({
            missionId: active.id,
            sessionId: ctx.sessionId,
            kind: "signal",
            summary: `wait_for_signal${plan ? ` (plan #${plan.id})` : ""}: ${summary}`,
            details: { rejected: r.rejected, seen: r.seen, sourceErrors: r.sourceErrors },
          });
        }
        return summary + (r.stopped ? "" : " Vuelve a llamar a wait_for_signal (con exclude si has descartado alguno a mano).");
      }
      positions.logResearch(ctx.missionId, "wait_for_signal", r.candidate.token);
      // La hora de la señal queda en la misión: con la de la compra (enter_with_exits), cuánto se tarda en entrar.
      if (active) mission.recordSignal(active.id, r.candidate.token, r.snapshot);
      return toText({
        signal: `${r.candidate.symbol ?? r.candidate.token} pasa los filtros${plan ? ` del plan #${plan.id}` : ""}`,
        ...r.candidate,
        ...waited,
        ...(sourceNote ? { sourceErrors: sourceNote } : {}),
        ...(plan?.body.manual_filters ? { checkByHand: plan.body.manual_filters } : {}),
        next: `enter_with_exits con token ${r.candidate.token}${plan ? ` y thesis { plan_ref: ${plan.id} }` : ""}`,
      });
    },
  }),
  tool({
    name: "http_get",
    kind: "research",
    role: MARKET_READERS,
    researchTarget: (i) => i.url,
    description: "Hace una petición HTTP GET y devuelve la respuesta en texto (útil para APIs públicas en JSON).",
    schema: z.object({ url: z.string() }),
    run: async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("Solo se permiten URLs http(s)");
      const { status, body } = await fetchText(url, { timeoutMs: 20_000 });
      memory.recordApiCall(url, status);
      return `HTTP ${status}\n${body.slice(0, 20000)}${body.length > 20000 ? `\n… (truncado, ${body.length} caracteres en total)` : ""}`;
    },
  }),

  // ─── Cartera simulada ─────────────────────────────────────────────────────
  tool({
    name: "portfolio",
    kind: "misc",
    role: MARKET_READERS,
    deliversNews: true,
    description:
      "Muestra tu cartera simulada y su valor en USD a precio de liquidación real ahora mismo, " +
      "el PnL desde el inicio, la dirección de tu monedero EVM y una referencia: lo que valdría tu cartera inicial si no hubieras operado.",
    schema: z.object({}),
    run: async (_i, ctx) => json(await sim.valuation(mid(ctx))),
  }),
  tool({
    name: "quote_swap",
    kind: "research",
    role: MARKET_READERS,
    researchTarget: (i) => i.output,
    description:
      "Cotiza un swap en una cadena sin ejecutarlo, con el agregador de DEX real de esa cadena (en Solana, Jupiter). " +
      `input/output: dirección del token, o un alias (${TOKEN_ALIASES}). amount en unidades del token de entrada.`,
    schema: z.object({
      chain: chainParam,
      input: z.string(),
      output: z.string(),
      amount: z.number().positive(),
      slippage_bps: z.number().int().min(1).max(5000).default(50),
    }),
    run: async (i, ctx) => json(await sim.quoteSwap(i.chain, i.input, i.output, i.amount, i.slippage_bps, ctx.missionId)),
  }),
  tool({
    name: "simulate_swap",
    kind: "trade",
    journaled: true,
    description:
      "Ejecuta en simulación un swap en tu monedero de una cadena. El resultado es la cotización real del agregador en ese instante " +
      "(liquidez y comisiones de los pools incluidas) y se descuentan los costes de red de esa cadena. " +
      "En Solana: fee de red en SOL y, si recibes un token nuevo, la renta de la cuenta del token (se recupera al vaciarla). " +
      `Necesitas el token nativo de la cadena para pagar la red. input/output: dirección del token o un alias (${TOKEN_ALIASES}). ` +
      "Indica amount (cantidad del token de entrada) o sell_all para vender todo tu saldo de ese token. " +
      "slippage_bps protege la cotización que acabas de ver: si cotizaste este mismo swap con quote_swap hace menos de 60 s y el precio se ha movido " +
      "más que tu slippage, el swap revierte (pagas solo la red). Sin cotización previa, se ejecuta al precio del momento. " +
      "Con costes realistas (mission_status.costs empieza por \"real\"), en Solana siempre se vuelve a cotizar tras la latencia: sin quote_swap previo, " +
      "el slippage se mide contra la cotización con la que se decidió y, si ha empeorado más, revierte y pagas la red. En memecoins usa ~300 bps (con 50 revierte a menudo). " +
      "En una misión rápida, comprar un token sigue las reglas de enter_with_exits: no compra un token descartado (su compra revirtió) ni con más " +
      `slippage que el del plan (por defecto, ${ENTRY_SLIPPAGE_BPS}). Vender no tiene tope.`,
    schema: z.object({
      chain: chainParam,
      input: z.string(),
      output: z.string(),
      amount: z.number().positive().optional(),
      sell_all: z.boolean().optional().describe("Vende todo tu saldo del token de entrada (en lugar de amount)"),
      slippage_bps: z.number().int().min(1).max(5000).default(50),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      if (sim.isLiveMission(mid(ctx))) throw new Error("Esta misión es REAL: usa execute_swap (opera con dinero de verdad). simulate_swap solo sirve en misiones simuladas.");
      await checkFastBuy({ missionId: mid(ctx), chain: i.chain, output: i.output, slippageBps: i.slippage_bps, via: "simulate_swap" });
      await checkBuyAgainstMemory({ chain: i.chain, output: i.output, overrides: t.overrides, risksChecked: t.risks_checked, missionId: mid(ctx), input: i.input, amount: i.amount });
      return json(
        await sim.swap({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          chain: i.chain,
          input: i.input,
          output: i.output,
          amount: i.amount,
          sellAll: i.sell_all,
          slippageBps: i.slippage_bps,
          reasoning: formatThesis(t),
          meta: tradeMeta(t),
        }),
      );
    },
  }),
  tool({
    name: "execute_swap",
    kind: "trade",
    journaled: true,
    description:
      "Solo en misiones REALES: ejecuta un swap con dinero de verdad desde la cartera de la IA (Solana con Jupiter; Base y BNB Chain con KyberSwap). " +
      "Mismos parámetros que simulate_swap. Paga la red de verdad (también si la transacción falla) y, si la misión es de aprobación manual, " +
      "espera hasta ~90 s a que el usuario la apruebe. El firmante aplica los límites de la misión (máximo por operación y pérdida máxima). " +
      "slippage_bps se aplica en la cadena: si el precio se mueve más, la transacción revierte y solo pagas la red. " +
      "Siempre queda un poco del nativo (SOL, ETH, BNB) para pagar la red. Devuelve el hash, el enlace al explorador y las cantidades reales.",
    schema: z.object({
      chain: chainParam,
      input: z.string(),
      output: z.string(),
      amount: z.number().positive().optional(),
      sell_all: z.boolean().optional().describe("Vende todo tu saldo del token de entrada (en lugar de amount)"),
      slippage_bps: z.number().int().min(1).max(5000).default(100),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      if (!sim.isLiveMission(mid(ctx))) throw new Error("Esta misión es simulada: usa simulate_swap. execute_swap solo existe en misiones reales.");
      await checkBuyAgainstMemory({ chain: i.chain, output: i.output, overrides: t.overrides, risksChecked: t.risks_checked, missionId: mid(ctx), input: i.input, amount: i.amount });
      return json(
        await sim.swap({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          chain: i.chain,
          input: i.input,
          output: i.output,
          amount: i.amount,
          sellAll: i.sell_all,
          slippageBps: i.slippage_bps,
          reasoning: formatThesis(t),
          meta: tradeMeta(t),
        }),
      );
    },
  }),
  tool({
    name: "simulate_binance_market_order",
    kind: "trade",
    journaled: true,
    description:
      "Ejecuta en simulación una orden de mercado en Binance spot contra el order book real (precio medio y slippage reales, " +
      "comisión taker incluida). BUY: amount = cantidad del activo quote a gastar. SELL: amount = cantidad del activo base a vender. " +
      "symbol: par de Binance, p. ej. BTCUSDC.",
    schema: z.object({ symbol: z.string(), side: z.enum(["BUY", "SELL"]), amount: z.number().positive(), thesis: thesisParam }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      return json(await sim.binanceMarketOrder({ missionId: mid(ctx), sessionId: ctx.sessionId, symbol: i.symbol, side: i.side, amount: i.amount, reasoning: formatThesis(t), meta: tradeMeta(t) }));
    },
  }),
  tool({
    name: "simulate_transfer",
    kind: "trade",
    journaled: true,
    description:
      "Deposita en Binance desde uno de tus monederos, o retira de Binance a uno de ellos, por la red de esa cadena. " +
      "Redes: USDC por Solana, Base o BNB Chain; USDT por Solana o BNB Chain; SOL por Solana; ETH por Base; BNB por BNB Chain. " +
      "Al depositar pagas la red de la cadena (en su nativo); al retirar, la comisión de retirada de Binance (y hay un mínimo). " +
      "El dinero sale al momento y llega unos minutos después (mientras tanto aparece en tu cartera como en tránsito). " +
      "Entre dos cadenas usa simulate_bridge.",
    schema: z.object({
      asset: z.enum(transfers.TRANSFER_ASSETS),
      from: z.enum(VENUES),
      to: z.enum(VENUES),
      amount: z.number().positive(),
      reasoning,
    }),
    run: async (i, ctx) => json(await transfers.cexTransfer({ missionId: mid(ctx), sessionId: ctx.sessionId, ...i })),
  }),
  tool({
    name: "quote_bridge",
    kind: "research",
    researchTarget: (i) => i.token_out,
    description:
      "Estimación orientativa de un puente entre dos cadenas (Solana, Base, BNB Chain): cuánto recibirías y el gas aproximado. " +
      "No gasta nada. El coste, el gas y la duración reales los da el agregador de puentes al ejecutarlo con simulate_bridge.",
    schema: z.object({
      from_chain: chainParam,
      to_chain: chainParam,
      token_in: z.string().describe(`Token que envías (dirección o alias: ${TOKEN_ALIASES})`),
      token_out: z.string().describe("Token que quieres recibir en la cadena de destino (dirección o alias)"),
      amount: z.number().positive(),
    }),
    run: async (i) => json(await transfers.quoteBridge({ fromChain: i.from_chain, toChain: i.to_chain, tokenIn: i.token_in, tokenOut: i.token_out, amount: i.amount })),
  }),
  tool({
    name: "simulate_bridge",
    kind: "trade",
    journaled: true,
    description:
      "Cruza un puente entre dos cadenas (Solana, Base, BNB Chain) con Li.Fi, que elige el puente y la ruta. Puedes cambiar de token " +
      "por el camino (p. ej. USDC de Base a BNB en BNB Chain). Pagas el gas en la cadena de origen (en su nativo) y la comisión del " +
      "puente va incluida en lo que recibes. El dinero sale al momento y llega cuando indique el puente (segundos o minutos).",
    schema: z.object({
      from_chain: chainParam,
      to_chain: chainParam,
      token_in: z.string().describe(`Token que envías (dirección o alias: ${TOKEN_ALIASES})`),
      token_out: z.string().describe("Token que quieres recibir en la cadena de destino (dirección o alias)"),
      amount: z.number().positive(),
      slippage_bps: z.number().int().min(1).max(5000).default(50),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      return json(
        await transfers.bridge({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          fromChain: i.from_chain,
          toChain: i.to_chain,
          tokenIn: i.token_in,
          tokenOut: i.token_out,
          amount: i.amount,
          slippageBps: i.slippage_bps,
          reasoning: formatThesis(t),
          meta: tradeMeta(t),
        }),
      );
    },
  }),
  tool({
    name: "execute_bridge",
    kind: "trade",
    journaled: true,
    description:
      "Solo en misiones REALES: mueve dinero de verdad entre tus cadenas (Solana, Base, BNB Chain) con Li.Fi. Solo estables (USDC, USDT) " +
      "o el nativo (SOL, ETH, BNB), de ida y de llegada: para mover un token, véndelo antes con execute_swap. Pagas el gas real en la cadena " +
      "de origen y la comisión del puente va descontada de lo que recibes. Si la aprobación es manual, espera a que el usuario la apruebe. " +
      "Mientras llega aparece \"en tránsito\"; la llegada la confirma Li.Fi (segundos o minutos).",
    schema: z.object({
      from_chain: chainParam,
      to_chain: chainParam,
      token_in: z.string().describe("Estable o nativo que envías (USDC, USDT, SOL, ETH, BNB o su dirección)"),
      token_out: z.string().describe("Estable o nativo que quieres recibir en la cadena de destino"),
      amount: z.number().positive(),
      slippage_bps: z.number().int().min(1).max(5000).default(50),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      if (!sim.isLiveMission(mid(ctx))) throw new Error("Esta misión es simulada: usa simulate_bridge. execute_bridge solo existe en misiones reales.");
      const { liveBridge } = await import("../live/bridge.js");
      return json(
        await liveBridge({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          fromChain: i.from_chain,
          toChain: i.to_chain,
          tokenIn: i.token_in,
          tokenOut: i.token_out,
          amount: i.amount,
          slippageBps: i.slippage_bps,
          reasoning: formatThesis(t),
        }),
      );
    },
  }),
  tool({
    name: "open_perp",
    kind: "trade",
    journaled: true,
    description:
      "Futuros perpetuos (simulados con datos reales de Hyperliquid): abre una posición larga (gana si sube) o corta (gana si baja) " +
      "con apalancamiento sobre BTC, ETH, SOL, BNB y muchas más (cada moneda tiene su apalancamiento máximo: strategy_fit y el error te lo dicen). " +
      "El margen sale del efectivo (USDC/USDT) de una de tus cadenas (from_chain, o la que más tenga) y vuelve a ella al cerrar. " +
      "Costes: depósito 0,3 $, comisión 0,045 % del nocional al abrir y al cerrar, funding cada hora y retirada 1 $. " +
      "Si el capital de la posición baja del mantenimiento, se liquida y pierdes el margen: la respuesta dice el precio de liquidación. " +
      "Opcional: take_profit y stop_loss (precios) que se vigilan solos. Mínimo 10 $ de nocional. Solo en misiones simuladas.",
    schema: z.object({
      coin: z.string().describe("Moneda del perpetuo: BTC, ETH, SOL, BNB…"),
      side: z.enum(["long", "short"]),
      leverage: z.number().min(1).max(50),
      margin_usd: z.number().positive().describe("Cuánto de tu efectivo pones como margen"),
      from_chain: chainParam.optional().describe("De qué cadena sale el margen (por defecto, la que más efectivo tenga)"),
      take_profit: z.number().positive().optional(),
      stop_loss: z.number().positive().optional(),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      const { openPerp } = await import("../sim/perps.js");
      return json(
        await openPerp({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          coin: i.coin,
          side: i.side,
          leverage: i.leverage,
          marginUsd: i.margin_usd,
          fromChain: i.from_chain,
          takeProfit: i.take_profit,
          stopLoss: i.stop_loss,
          reasoning: formatThesis(t),
          meta: tradeMeta(t),
        }),
      );
    },
  }),
  tool({
    name: "close_perp",
    kind: "trade",
    journaled: true,
    description: "Cierra un futuro abierto (id en portfolio → perps) al precio mark del momento; el margen más el resultado vuelve a su cadena.",
    schema: z.object({ perp_id: z.number().int(), reasoning: z.string().min(1) }),
    run: async (i, ctx) => {
      const { closePerp } = await import("../sim/perps.js");
      return json(await closePerp({ missionId: mid(ctx), sessionId: ctx.sessionId, perpId: i.perp_id, reasoning: i.reasoning }));
    },
  }),
  tool({
    name: "set_perp_exits",
    kind: "trade",
    journaled: true,
    description:
      "Pone, cambia o quita la toma de beneficio y el stop de un futuro ya abierto (id en portfolio → perps). Así puedes calcularlos " +
      "con el precio de entrada real que te devolvió open_perp. Un precio fija la salida; 0 la quita; si no pasas uno, se queda como estaba.",
    schema: z.object({
      perp_id: z.number().int(),
      take_profit: z.number().min(0).optional(),
      stop_loss: z.number().min(0).optional(),
      reasoning: z.string().min(1),
    }),
    run: async (i, ctx) => {
      const { setPerpExits } = await import("../sim/perps.js");
      return json(await setPerpExits({ missionId: mid(ctx), sessionId: ctx.sessionId, perpId: i.perp_id, takeProfit: i.take_profit, stopLoss: i.stop_loss, reasoning: i.reasoning }));
    },
  }),
  tool({
    name: "place_swap_trigger_order",
    kind: "trade",
    journaled: true,
    description:
      "Deja una orden condicional en una cadena: cuando el precio en USD de trigger_asset cruce trigger_price (above = sube hasta o por encima, " +
      "below = baja hasta o por debajo), se ejecuta el swap indicado a mercado con la cotización real de ese instante. " +
      "Si la orden vende trigger_asset (toma de beneficios o stop), el precio que se vigila es el de venderlo de verdad: la cotización de " +
      "vender esa cantidad a un estable, ya con el impacto de precio (currentPrice te lo da así al crearla). " +
      "Una toma de beneficios (above, vendiendo a un estable) es una orden límite: se llena exactamente a ese precio (como en Jupiter, aunque el mercado esté por encima); si al ir a vender " +
      "el precio ya ha bajado, no se llena y sigue esperando. Un stop (below) vende a mercado, al precio que haya. " +
      "Funciona aunque no estés en sesión. Se comprueba cada 15 s (cada 5 s en una misión rápida), así que un pico de pocos segundos puede no dispararla. " +
      "El saldo no se bloquea: si al dispararse no hay saldo suficiente, la orden falla. Con sell_all vende todo el saldo que tengas en ese momento. " +
      "Con condition: time se ejecuta dentro de in_minutes pase lo que pase con el precio (sin trigger_asset ni trigger_price): sirve para cumplir tu plan " +
      "(\"si a los 3 min no ha saltado la toma de beneficio, vendo\") aunque no estés pendiente. Cancela la que sobre cuando se ejecute la otra.",
    schema: z.object({
      chain: chainParam,
      trigger_asset: z.string().optional().describe(`Dirección del token cuyo precio se vigila, o un alias (${TOKEN_ALIASES}). No en las de tiempo`),
      condition: z.enum(["above", "below", "time"]),
      trigger_price: z.number().positive().optional().describe("Precio en USD. No en las de tiempo"),
      in_minutes: z.number().positive().optional().describe("Solo con condition: time. Dentro de cuántos minutos se ejecuta"),
      input: z.string(),
      output: z.string(),
      amount: z.number().positive().optional().describe("Cantidad del token de entrada"),
      sell_all: z.boolean().optional().describe("Vender todo el saldo del token de entrada al dispararse (en lugar de amount)"),
      slippage_bps: z.number().int().min(1).max(5000).default(100),
      expires_hours: z.number().positive().optional(),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      if (!i.sell_all && i.amount === undefined) throw new Error("Indica amount o sell_all");
      await checkFastBuy({ missionId: mid(ctx), chain: i.chain, output: i.output, slippageBps: i.slippage_bps, via: "una orden condicional" });
      await checkBuyAgainstMemory({ chain: i.chain, output: i.output, overrides: t.overrides, risksChecked: t.risks_checked, missionId: mid(ctx), input: i.input, amount: i.amount });
      return json(
        await orders.placeOrder({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          venue: i.chain,
          triggerAsset: i.trigger_asset,
          condition: i.condition,
          triggerPrice: i.trigger_price,
          inMinutes: i.in_minutes,
          action: { input: i.input, output: i.output, amount: i.amount ?? 0, sellAll: i.sell_all || undefined, slippageBps: i.slippage_bps },
          expiresHours: i.expires_hours,
          reasoning: formatThesis(t),
        }),
      );
    },
  }),
  tool({
    name: "enter_with_exits",
    kind: "trade",
    startsClock: true,
    journaled: true,
    description:
      "Entrada de una misión rápida en UNA llamada: compra el token con todo tu efectivo de la cadena (el nativo se queda para la red) o con " +
      "usd_amount; si el reloj no corría, lo arranca en el momento en que la compra se llena (igual que start_session), y deja puesta la toma de " +
      "beneficio: una orden límite que vende todo el token a un precio fijo. Ese precio sale de tp_ratio (× el precio de compra), del plan citado " +
      "o, si no, del objetivo de la misión (el que la deja cumplida neta de costes; también con tp_at_target, p. ej. en una reentrada). Devuelve " +
      "la compra, la orden y el plazo del reloj. Antes de comprar lo comprueba todo (tesis o plan, efectivo, token, slippage, una cotización de " +
      "ida y vuelta —más del 10 % es un pool vaciado— y tu memoria): si algo falla, o si la compra revierte, no compra ni arranca el reloj. " +
      "Una compra que revierte porque el precio se ha movido más que el slippage deja ese token descartado en la misión: wait_for_signal no " +
      `lo vuelve a dar y aquí no se reintenta. El slippage no puede pasar del del plan (por defecto, ${ENTRY_SLIPPAGE_BPS} = 3 %). ` +
      "Con thesis { plan_ref } la tesis es la del plan. Solo en misiones simuladas.",
    schema: z.object({
      chain: chainParam.default("solana"),
      token: z.string().describe("Dirección del token (la que da wait_for_signal)"),
      usd_amount: z.number().positive().optional().describe("Cuánto gastar (por defecto, el importe del plan o todo el efectivo de la cadena)"),
      tp_ratio: z.number().min(1.01).max(20).optional().describe("Toma de beneficio = precio de compra × tp_ratio (por defecto, la del plan o la del objetivo)"),
      tp_at_target: z.boolean().optional().describe("Toma de beneficio en el precio que deja el objetivo cumplido, aunque el plan tenga tp_ratio"),
      slippage_bps: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe(`Por defecto y como máximo, el del plan (${ENTRY_SLIPPAGE_BPS} si no fija otro): no se sube para forzar una entrada que revierte`),
      thesis: thesisParam,
    }),
    // Todo lo que puede fallar sin operar se comprueba antes de comprar (runTool): si falla, el reloj sigue parado y el
    // executor espera al siguiente candidato gratis.
    preflight: async (i, ctx) => {
      const m = mid(ctx);
      if (sim.isLiveMission(m)) throw new Error("enter_with_exits solo existe en misiones simuladas");
      const t = fullThesis(i.thesis, ctx);
      const plan = "plan_ref" in i.thesis ? plans.getPlan(i.thesis.plan_ref) : undefined;
      // El slippage de la compra: el del plan (el citado o el de la misión) o el de por defecto, y nunca más. Subirlo tras
      // una reversión es entrar justo en lo que la reversión evitaba (M18: al 25 % entró, y el token cayó un 79 %).
      const slippagePlan = plan ?? plans.planForMission(m);
      const maxSlippage = entrySlippageBps(slippagePlan);
      const slippageBps = i.slippage_bps ?? maxSlippage;
      if (slippageBps > maxSlippage) {
        const from = slippagePlan?.body.slippage_bps !== undefined ? `el del plan #${slippagePlan.id}` : "el de por defecto";
        throw new Error(
          `slippage_bps ${slippageBps} pasa del tope de ${maxSlippage} (${from}): una entrada no se fuerza subiendo el slippage. Si la compra ` +
            "revierte, el precio se está moviendo en tu contra más de lo que admite el plan, y eso es justo de lo que protege la reversión. " +
            "Espera al siguiente candidato con wait_for_signal",
        );
      }
      const excluded = entryExclusion(m, i.token);
      if (excluded) throw new Error(`Ese token ya está descartado en esta misión (${excluded.reason}): no se reintenta. Espera al siguiente candidato con wait_for_signal`);
      // El importe fijo del plan se recorta al efectivo (la clase no dice el capital); uno pedido aquí tiene que caber.
      const entry = await prepareEntry({
        missionId: m,
        chain: i.chain,
        token: i.token,
        usdAmount: i.usd_amount,
        planUsdAmount: plan?.body.usd_amount,
        slippageBps,
        // El plan puede subir el tope mecánico de la ida y vuelta, no bajarlo aquí: esto es la red contra un pool vaciado.
        maxRoundTripCostPct: Math.max(DEFAULT_MAX_ROUND_TRIP_COST_PCT, plan?.body.filters.max_round_trip_cost_pct ?? 0),
      });
      const resolved = entryExclusion(m, entry.token.address);
      if (resolved) throw new Error(`${entry.token.symbol} ya está descartado en esta misión (${resolved.reason}): no se reintenta. Espera al siguiente candidato con wait_for_signal`);
      await checkBuyAgainstMemory({ chain: i.chain, output: entry.token.address, overrides: t.overrides, risksChecked: t.risks_checked, missionId: m, input: entry.stable.address, amount: entry.amount });
      return { thesis: t, plan, entry, slippageBps };
    },
    // La compra: la única operación antes del reloj. runTool lo arranca solo si se llena, a la hora de la compra.
    entry: async (i, ctx, { thesis: t, entry, slippageBps }) =>
      buyEntry({
        missionId: mid(ctx),
        sessionId: ctx.sessionId,
        chain: i.chain,
        token: entry.token,
        stable: entry.stable,
        amount: entry.amount,
        slippageBps,
        reasoning: formatThesis(t),
        meta: tradeMeta(t),
      }),
    run: async (i, ctx, { thesis: t, plan, entry, slippageBps }, fill) => {
      const m = mid(ctx);
      const tpRatio = i.tp_ratio ?? (i.tp_at_target ? undefined : plan?.body.tp_ratio);
      let out: Awaited<ReturnType<typeof placeExits>>;
      try {
        out = await placeExits({
          missionId: m,
          sessionId: ctx.sessionId,
          chain: i.chain,
          fill,
          tpRatio,
          tpRatioFrom: i.tp_ratio !== undefined ? "parámetro" : plan ? `plan #${plan.id}` : undefined,
          slippageBps,
          reasoning: formatThesis(t),
        });
      } catch (err) {
        // La compra ya está hecha (y el reloj corre desde ella): el error no puede sonar a entrada rechazada.
        throw new Error(
          `La compra de ${fill.token.symbol} SÍ se ha hecho (${Number(fill.bought.toPrecision(6))} tokens por ${Number(fill.amount.toFixed(2))} ${fill.stable.symbol}) ` +
            `y el reloj corre desde ella, pero la toma de beneficio no se ha podido calcular ni poner (${(err as Error).message}). Ponla con place_swap_trigger_order`,
        );
      }
      // Con plan_ref, la misión queda con ese plan (su P y la de la línea base) para compararla después. Solo con la
      // compra hecha: una entrada rechazada no asigna nada.
      if (plan && mission.getMission(m)?.plan_id !== plan.id) plans.attachPlan(m, plan);
      return json({ ...out, roundTripAtEntry: { quotedBackUsd: Number(entry.roundTrip.backUsd.toFixed(2)), costPct: entry.roundTrip.costPct } });
    },
  }),
  tool({
    name: "place_binance_trigger_order",
    kind: "trade",
    journaled: true,
    description:
      "Deja una orden condicional en Binance: cuando el último precio de trigger_symbol cruce trigger_price, se ejecuta la orden de mercado " +
      "indicada contra el order book real de ese instante. Funciona aunque no estés en sesión; se comprueba aproximadamente cada minuto. " +
      "El saldo no se bloquea: si al dispararse no hay saldo suficiente, la orden falla. Con condition: time se ejecuta dentro de in_minutes, " +
      "pase lo que pase con el precio (sin trigger_symbol ni trigger_price).",
    schema: z.object({
      trigger_symbol: z.string().optional().describe("Par de Binance cuyo precio se vigila, p. ej. SOLUSDC. No en las de tiempo"),
      condition: z.enum(["above", "below", "time"]),
      trigger_price: z.number().positive().optional().describe("Precio en el activo quote del par. No en las de tiempo"),
      in_minutes: z.number().positive().optional().describe("Solo con condition: time. Dentro de cuántos minutos se ejecuta"),
      symbol: z.string().describe("Par en el que se ejecuta la orden"),
      side: z.enum(["BUY", "SELL"]),
      amount: z.number().positive().describe("BUY: cantidad de quote a gastar. SELL: cantidad base a vender"),
      expires_hours: z.number().positive().optional(),
      thesis: thesisParam,
    }),
    run: async (i, ctx) => {
      const t = fullThesis(i.thesis, ctx);
      return json(
        await orders.placeOrder({
          missionId: mid(ctx),
          sessionId: ctx.sessionId,
          venue: "binance",
          triggerAsset: i.trigger_symbol,
          condition: i.condition,
          triggerPrice: i.trigger_price,
          inMinutes: i.in_minutes,
          action: { symbol: i.symbol, side: i.side, amount: i.amount },
          expiresHours: i.expires_hours,
          reasoning: formatThesis(t),
        }),
      );
    },
  }),
  tool({
    name: "list_orders",
    kind: "misc",
    description: "Lista tus órdenes condicionales: abiertas, cerradas (ejecutadas, fallidas, canceladas, caducadas) o todas.",
    schema: z.object({ status: z.enum(["open", "closed", "all"]).default("open") }),
    run: async ({ status }, ctx) => toText(orders.listOrders(mid(ctx), status)),
  }),
  tool({
    name: "cancel_order",
    kind: "misc",
    journaled: true,
    description: "Cancela una orden condicional abierta.",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }, ctx) => orders.cancelOrder(mid(ctx), id, ctx.sessionId),
  }),
  tool({
    name: "estimate_token_launch",
    kind: "research",
    description:
      "Cuánto costaría lanzar un token propio en una cadena, con el gas y los precios de ahora: en Solana con pump.fun; en Base " +
      "y BNB Chain, desplegando un ERC-20 y creando su pool con la liquidez que indiques. El simulador no crea tokens (su mercado " +
      "depende de otras personas): si decides hacerlo, anótalo con record_hypothetical_action incluyendo esta estimación.",
    schema: z.object({
      chain: chainParam,
      initial_liquidity_usd: z.number().min(0).optional().describe("Liquidez inicial (o primera compra en pump.fun), en USD"),
    }),
    run: async (i) => json(await estimateTokenLaunch({ chain: i.chain, initialLiquidityUsd: i.initial_liquidity_usd })),
  }),
  tool({
    name: "record_hypothetical_action",
    kind: "misc",
    journaled: true,
    description:
      "Anota en el diario cualquier acción que harías pero que este simulador no puede ejecutar ni valorar " +
      "(de cualquier tipo). No cambia tu cartera. Describe con precisión qué harías, con qué parámetros y qué esperas que pase.",
    schema: z.object({
      action_type: z.string().describe("Nombre corto del tipo de acción, elegido por ti"),
      description: z.string(),
      details: z.string().describe("Parámetros concretos: nombres, cantidades, textos, URLs…"),
      expected_outcome: z.string(),
      reasoning,
    }),
    run: async (i, ctx) => {
      logJournal({
        missionId: ctx.missionId,
        sessionId: ctx.sessionId,
        kind: "hypothetical",
        summary: `[${i.action_type}] ${i.description}`,
        reasoning: i.reasoning,
        details: { details: i.details, expected_outcome: i.expected_outcome },
      });
      return "Anotado en el diario como acción hipotética (no afecta a la cartera).";
    },
  }),
  tool({
    name: "journal_history",
    kind: "memory",
    role: MARKET_READERS,
    researchTarget: () => undefined,
    description:
      "Devuelve las últimas entradas de tu diario de operaciones. Por defecto, de la misión actual; " +
      "con mission_id, las de una misión anterior (útil para analizarla y sacar lecciones).",
    schema: z.object({ limit: z.number().int().min(1).max(200).default(30), mission_id: z.number().int().optional() }),
    run: async ({ limit, mission_id }, ctx) => {
      const target = mission_id ?? ctx.missionId;
      if (target === null || !mission.getMission(target)) throw new Error(mission_id === undefined ? "No hay misiones" : `No existe la misión #${mission_id}`);
      return toText(db.prepare("SELECT ts, kind, summary, reasoning, details FROM journal WHERE mission_id = ? ORDER BY id DESC LIMIT ?").all(target, limit));
    },
  }),

  // ─── Plan del cerebro (misiones rápidas): lo escribe el planner antes del reloj; lo leen todos ─
  tool({
    name: "write_plan",
    kind: "memory",
    role: "planner",
    journaled: true,
    description:
      "Guarda el plan de una clase de misión (plazo × objetivo × mercado, p. ej. graduado-10m-+25%) y lo deja vigente: las reglas con las que " +
      `el executor opera las próximas ${plans.PLAN_BLOCK_SIZE} misiones de esa clase. Son reglas, no una lista de tokens (caducan en minutos): el evento, ` +
      "los filtros mecánicos (wait_for_signal los comprueba sin LLM) y los que hay que mirar a mano, el tamaño, el ratio de la toma de beneficio " +
      "calculado con quote_swap para el capital, la regla de reentrada, risks_checked ya validado, la P que esperas y la de la línea base, y " +
      "opcionalmente una lista corta de curvas de pump.fun llenas al 90 % o más. Queda fijo durante su bloque: si la clase ya tiene un plan que no " +
      "lo ha terminado, se rechaza salvo que des replace_reason. Sin duration_minutes ni target_pct, la clase es la de la misión activa. Solo " +
      `misiones rápidas (simuladas de ${mission.FAST_MISSION_MAX_MINUTES} min o menos), y el mercado de la clase es el de la fuente: graduado.`,
    schema: z.object({
      duration_minutes: z.number().positive().optional().describe("Plazo de la clase (por defecto, el de la misión activa)"),
      target_pct: z.number().positive().optional().describe("Objetivo de la clase en % sobre el capital (por defecto, el de la misión activa)"),
      market: z
        .string()
        .regex(/^[a-z0-9_]+$/)
        .optional()
        .describe(
          `Mercado de la clase: el de los eventos que da la fuente (${mission.DEFAULT_FAST_MARKET}, con graduado y con shortlist). Otro mercado se rechaza: ` +
            "wait_for_signal no sabe esperar sus eventos, y la misión se compararía con la línea base de otro mercado y sin gemelo",
        ),
      event: z.string().min(1).describe("El evento que dispara la entrada, p. ej. 'token de pump.fun migrado a PumpSwap hace 2 min o menos'"),
      source: z.enum(plans.SIGNAL_SOURCES).default("graduado").describe("Fuente de wait_for_signal: graduado o shortlist (solo la lista corta)"),
      filters: z
        .object({
          max_pool_age_minutes: z.number().positive().max(60).optional().describe("Edad máxima del pool o de la graduación (por defecto, 2)"),
          launchpads: z.array(z.string()).optional().describe('Launchpads de origen según Jupiter (por defecto en graduado, ["pump.fun"]; [] = cualquiera)'),
          min_liquidity_usd: z.number().min(0).optional(),
          max_liquidity_usd: z.number().positive().optional(),
          min_fdv_usd: z.number().min(0).optional(),
          max_fdv_usd: z.number().positive().optional(),
          min_buys_5m: z.number().int().min(0).optional(),
          min_buyers_5m: z.number().int().min(0).optional(),
          min_buy_sell_ratio_5m: z.number().min(0).optional(),
          min_volume_5m_usd: z.number().min(0).optional(),
          min_price_change_5m_pct: z.number().optional(),
          max_price_change_5m_pct: z.number().optional(),
          max_round_trip_cost_pct: z.number().min(0).max(100).optional().describe("Coste máximo de comprar y vender al momento con el capital"),
        })
        .default({})
        .describe("Filtros mecánicos propios (los datos del pool de GeckoTerminal y las cotizaciones de Jupiter)"),
      manual_filters: z.string().optional().describe("Filtros propios que no se pueden comprobar sin mirar: el executor los revisa antes de entrar"),
      sizing: z.string().min(1).default("todo el capital menos el gas"),
      usd_amount: z.number().positive().optional().describe("Importe fijo de cada entrada (por defecto, todo el efectivo de la cadena)"),
      tp_ratio: z.number().min(1.01).max(20).optional().describe("Toma de beneficio = precio de compra × tp_ratio (sin él, en el precio que da el objetivo neto)"),
      slippage_bps: z
        .number()
        .int()
        .min(50)
        .max(1000)
        .optional()
        .describe(
          `Slippage de la compra de enter_with_exits (por defecto, ${ENTRY_SLIPPAGE_BPS} = 3 %; el gemelo usa el mismo). Es un tope: el executor no puede ` +
            "subirlo para forzar una entrada que revierte",
        ),
      reentry: z.string().min(1).describe("Regla de reentrada (o por qué no la hay)"),
      reentry_allowed: z.boolean(),
      risks_checked: z.string().min(15).describe("Lo comprobado en contra (creencias negativas, riskCheck): vale para cada compra que cite el plan"),
      why: z.string().min(1),
      evidence: z.string().min(1).describe("Datos que lo respaldan (tus misiones, las tasas medidas)"),
      sources: z.array(z.string().min(1)).min(1),
      beliefs_applied: z.array(z.number().int()).optional(),
      memory_note: z.string().optional(),
      predicted_p: z.number().min(0).max(1).describe("P de llegar al objetivo con este plan (0-1)"),
      baseline_p: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("P de la línea base: la regla mecánica sin tus filtros (0-1). Por defecto, la de la tabla medida para la clase (strategy_fit)"),
      shortlist: z
        .array(z.object({ mint: z.string().min(32), note: z.string().optional() }))
        .max(10)
        .optional()
        .describe("Curvas de pump.fun llenas al 90 % o más (las siguientes en graduarse)"),
      replace_reason: z.string().min(20).optional().describe("Solo para sustituir un plan que no ha terminado su bloque: por qué no sirve"),
    }),
    run: async (i, ctx) => {
      const { duration_minutes, target_pct, market: asked, predicted_p, baseline_p, replace_reason, ...body } = i;
      if (body.source === "shortlist" && !body.shortlist?.length) throw new Error("Con source: shortlist, el plan necesita la lista corta (shortlist)");
      // El mercado de la clase es el de lo que de verdad se opera: el de la fuente. Una etiqueta distinta cambiaría la
      // línea base con la que se compara la misión y la dejaría sin gemelo.
      const market = plans.SOURCE_MARKET[body.source];
      if (asked && asked !== market) {
        throw new Error(
          `El mercado de un plan es el de su fuente: con source ${body.source}, wait_for_signal espera tokens recién graduados (${market}). ` +
            `Para ${asked} no hay fuente de eventos mecánica: su casilla de strategy_fit sirve de referencia, pero no se puede planificar`,
        );
      }
      const unknown = body.beliefs_applied?.length ? memory.unknownBeliefs(body.beliefs_applied) : [];
      if (unknown.length) throw new Error(`Las creencias #${unknown.join(", #")} no existen o ya no están activas`);
      let cls: string;
      if (duration_minutes !== undefined && target_pct !== undefined) {
        if (!mission.isFastMinutes(duration_minutes)) throw new Error(`Los planes son de misiones rápidas: ${mission.FAST_MISSION_MAX_MINUTES} min o menos`);
        cls = mission.missionClass({ durationMinutes: duration_minutes, initialUsd: 100, targetUsd: 100 * (1 + target_pct / 100), market });
      } else if (duration_minutes === undefined && target_pct === undefined) {
        const m = mission.getActiveMission();
        if (!m) throw new Error("No hay misión activa: indica duration_minutes y target_pct de la clase");
        if (!mission.isFastMission(m)) throw new Error("La misión activa no es rápida (simulada de 15 min o menos): la opera el trader, sin plan");
        cls = mission.missionClass({ durationMinutes: mission.missionDurationMinutes(m), initialUsd: m.initial_usd, targetUsd: m.target_usd, market });
      } else {
        throw new Error("Indica duration_minutes y target_pct juntos (o ninguno, para usar los de la misión activa)");
      }
      const baselineP = baseline_p ?? baselineForClass(cls)?.p;
      if (baselineP === undefined) throw new Error(`Indica baseline_p: la tabla medida no tiene el mercado de ${cls} (strategy_fit dice cuáles tiene)`);
      const r = plans.writePlan({ cls, body, predictedP: predicted_p, baselineP, missionId: ctx.missionId, sessionId: ctx.sessionId, replaceReason: replace_reason });
      return (
        `Plan #${r.id} vigente para ${cls}${r.replaced ? ` (sustituye al #${r.replaced})` : ""}: queda fijo durante las próximas ${plans.PLAN_BLOCK_SIZE} misiones ` +
        `de esta clase. El executor lo lee con get_plan y lo cita con plan_ref.`
      );
    },
  }),
  tool({
    name: "get_plan",
    kind: "memory",
    role: AGENTS,
    description:
      "El plan del cerebro: las reglas de las misiones rápidas de una clase (evento, filtros, tamaño, toma de beneficio, reentrada, P esperada y " +
      "de la línea base, lista corta) y cómo va su bloque. Por defecto, el de la misión activa (o el vigente de su clase); con mission_class, el " +
      "vigente de esa clase; con plan_id, ese. Sin misión activa, el vigente más reciente.",
    schema: z.object({
      plan_id: z.number().int().optional(),
      mission_class: z.string().optional().describe("Clase de misión, p. ej. graduado-10m-+25%"),
    }),
    run: async ({ plan_id, mission_class }, ctx) => {
      const active = ctx.missionId !== null && mission.getMission(ctx.missionId)?.status === "active";
      const plan =
        plan_id !== undefined
          ? plans.getPlan(plan_id)
          : mission_class
            ? plans.activePlan(mission_class)
            : active
              ? plans.planForMission(ctx.missionId!)
              : plans.latestActivePlan();
      if (!plan) {
        if (plan_id !== undefined) throw new Error(`No existe el plan #${plan_id}`);
        const cls = mission_class ?? (active ? mission.getMission(ctx.missionId!)?.class : undefined);
        return `No hay plan vigente${cls ? ` para ${cls}` : ""}: lo escribe el planner con write_plan.`;
      }
      const current = plan.active ? undefined : plans.activePlan(plan.class);
      return toText({ ...plans.describePlan(plan), ...(current ? { note: `Ya no está vigente: el de ${plan.class} es el #${current.id}` } : {}) });
    },
  }),

  // ─── Memoria entre misiones (el agente que opera la lee; la escribe el revisor) ─
  tool({
    name: "recall_memory",
    kind: "memory",
    role: MARKET_READERS,
    researchTarget: () => undefined,
    description:
      "Tu memoria entre misiones, ordenada por parecido con la misión actual. La escribe un agente revisor a partir de lo que pasó " +
      "en tus misiones. Incluye: howtos (cómo se hace algo y qué errores evitar), creencias sobre el mercado con su evidencia real " +
      "(calculada por el simulador con tus operaciones), el historial de misiones con lo que conviene hacer la próxima vez, " +
      "estadísticas de tus operaciones, los errores que se repiten y qué APIs han respondido bien. Por defecto, un resumen: howtos por " +
      "título y las creencias más relevantes. Con howto_ids, el texto de esos howtos; con detail: completo, todo (largo).",
    schema: z.object({
      detail: z.enum(["resumen", "completo"]).default("resumen"),
      howto_ids: z.array(z.number().int()).optional().describe("Ids de los howtos cuyo texto completo quieres leer"),
    }),
    run: async ({ detail, howto_ids }, ctx) => {
      if (howto_ids?.length) return toText({ howtos: memory.howtosById(howto_ids) });
      return toText(detail === "completo" ? memory.recall(ctx.missionId) : memory.recallSummary(ctx.missionId));
    },
  }),
  tool({
    name: "trade_history",
    kind: "memory",
    role: MARKET_READERS,
    researchTarget: () => undefined,
    description:
      "Tus posiciones: coste, resultado real, tiempo mantenida, motivo de cierre, datos del token al entrar (antigüedad, liquidez, " +
      "variación, holders, riesgos), cuánto habías investigado antes, tu tesis y las creencias que aplicaste. Por defecto, las de la " +
      "misión actual; con mission_id, las de otra; con all_missions: true, las últimas de todas (largo).",
    schema: z.object({
      mission_id: z.number().int().optional(),
      all_missions: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(30),
    }),
    run: async ({ mission_id, all_missions, limit }, ctx) => {
      const target = all_missions ? undefined : (mission_id ?? ctx.missionId ?? undefined);
      // La nota de memoria ya va dentro de la tesis ("Memoria: …"); con una sola misión, su id sobra.
      return toText(
        positions
          .listPositions(target)
          .slice(0, limit)
          .map(({ lessonsApplied, missionId, ...p }) => ({
            ...(target === undefined ? { missionId } : {}),
            ...p,
            ...(lessonsApplied && !(p.thesis ?? "").includes(lessonsApplied) ? { lessonsApplied } : {}),
          })),
      );
    },
  }),
  tool({
    name: "report_observation",
    kind: "memory",
    role: OPERATORS,
    journaled: true,
    description:
      "Deja una observación para el revisor, que decidirá si pasa a tu memoria: algo que has descubierto sobre cómo se hace algo, " +
      "un error y cómo lo has resuelto, un patrón del mercado que te ha llamado la atención… Úsala en cuanto lo veas, no al final.",
    schema: z.object({
      kind: z.enum(["procedimiento", "mercado", "error", "otro"]),
      text: z.string().min(1).describe("Qué has observado, con datos concretos"),
    }),
    run: async ({ kind, text }, ctx) => `Observación #${memory.reportObservation(ctx.missionId, ctx.sessionId, kind, text)} anotada para el revisor.`,
  }),
  tool({
    name: "request_capability",
    kind: "memory",
    role: AGENTS,
    journaled: true,
    description:
      "Anota una capacidad que no tienes y que necesitarías para intentar algo: una cuenta (X, Instagram, Telegram, un exchange…), " +
      "una herramienta (navegador con sesión iniciada, un bot, una API de pago…), unos datos o un mercado que el simulador no permite. " +
      "El usuario revisa estas peticiones y puede dártelas en el futuro. Explica qué harías exactamente con ella. No sustituye a " +
      "record_hypothetical_action: esa anota lo que harías; esta, lo que te falta para poder hacerlo.",
    schema: z.object({
      category: z.enum(memory.CAPABILITY_CATEGORIES),
      capability: z.string().min(1).describe("Qué necesitas, en pocas palabras (p. ej. 'cuenta de X para publicar')"),
      why: z.string().min(1).describe("Por qué lo necesitas: qué has intentado sin ello y por qué no basta"),
      plan: z.string().min(1).describe("Qué harías con ello, paso a paso, y qué esperas conseguir"),
    }),
    run: async (i, ctx) => {
      const r = memory.requestCapability({ source: "trader", missionId: ctx.missionId, ...i });
      return r.duplicate
        ? `Ya estaba pedida (#${r.id}): se suma tu petición. El usuario la verá.`
        : `Petición #${r.id} anotada. El usuario la verá en el panel y en /dementeking:estado.`;
    },
  }),

  // ─── Revisor: lee todo lo ocurrido y escribe la memoria ────────────────────
  tool({
    name: "exploration_map",
    kind: "memory",
    role: AGENTS,
    description:
      "Mapa de lo que has probado: operaciones cerradas por cadena, por edad y liquidez del token al entrar (contado) y por moneda (futuros), " +
      "con ganadas, perdidas y resultado medio. Las casillas \"sin probar\" son zonas en las que nunca has operado.",
    schema: z.object({}),
    run: async () => json(memory.explorationMap()),
  }),
  tool({
    name: "review_queue",
    kind: "memory",
    role: "reviewer",
    description:
      "Lo que tienes pendiente como revisor: misiones terminadas sin retrospectiva, la misión activa (actividad desde tu última revisión, " +
      "cada cuánto conviene revisarla y si tiene briefing), observaciones del agente sin procesar, errores repetidos sin howto y creencias sin condición. " +
      "missionClasses: por clase de misión, aciertos con su IC de Wilson, la suma de las P predichas frente a los aciertos (calibración), la " +
      "línea base, los aciertos del gemelo mecánico y la comparación misión a misión con él; `candles`, los aciertos del agente y del gemelo " +
      "medidos con velas de 1 min (la misma vara para los dos: los del gemelo con cotizaciones pueden quedarse cortos, ver twinObservation).",
    schema: z.object({}),
    run: async () => toText(memory.reviewQueue()),
  }),
  tool({
    name: "entry_dataset",
    kind: "memory",
    role: ["planner", "reviewer"],
    description:
      "Las entradas de una clase de misión rápida, una fila por entrada del agente y por gemelo mecánico: su ficha al entrar (edad del pool y " +
      "desde la graduación, liquidez, FDV y mcap, compras, compradores y volumen de 5 min, holders, % de los mayores holders y del creador, " +
      "sus lanzamientos, organicScore, ida y vuelta…), su resultado real (realHit, retPct) y el medido con velas de 1 min (wick/close, minutos " +
      "hasta tocar la toma de beneficio, lo más bajo antes y lo más alto). Con classStats de la clase (aciertos del agente, del gemelo con " +
      "cotizaciones y de los dos con velas, con su IC). Con split_by (un campo de la ficha) y split_at, los aciertos de cada lado con su IC, " +
      "del agente, de los gemelos y de todos: para buscar un filtro con evidencia antes de proponerlo.",
    schema: z.object({
      mission_class: z.string().optional().describe("Clase, p. ej. graduado-10m-+25% (por defecto, la de la misión activa o la del plan vigente)"),
      costs: z.enum(["sim", "real"]).optional().describe("Solo las misiones con ese modo de costes (por defecto, todas: cada fila dice el suyo)"),
      who: z.enum(["all", "agent", "twin"]).default("all"),
      split_by: z.string().optional().describe("Campo de la ficha por el que partir las entradas, p. ej. holders, jupMcapUsd, topHoldersPct, mintDisabled"),
      split_at: z.number().optional().describe("Umbral de split_by (≤ y >); por defecto, su mediana"),
      limit: z.number().int().min(1).max(400).default(120).describe("Filas, las más recientes"),
    }),
    run: async (i, ctx) => {
      const { classMissionIds, defaultDatasetClass, entryDataset } = await import("../sim/entry-dataset.js");
      const m = ctx.missionId !== null ? mission.getMission(ctx.missionId) : undefined;
      const cls = i.mission_class ?? defaultDatasetClass(m?.class, plans.latestActivePlan()?.class);
      if (!cls) return "Aún no hay entradas de misiones rápidas: indica mission_class cuando las haya.";
      // Si faltan velas de entradas ya terminadas, unas pocas ahora (el bucle de fondo mide el resto poco a poco).
      const { checkCandleOutcomes } = await import("../sim/candles.js");
      await checkCandleOutcomes({ missionIds: classMissionIds(cls), maxRequests: 2 }).catch(() => []);
      return toText(entryDataset({ cls, costs: i.costs, who: i.who, splitBy: i.split_by, splitAt: i.split_at, limit: i.limit }));
    },
  }),
  tool({
    name: "mission_review_data",
    kind: "memory",
    role: "reviewer",
    description:
      "Todo lo ocurrido en una misión en una sola llamada: misión, estadísticas, posiciones (con tesis, creencias aplicadas, datos de entrada " +
      "y resultado), diario, registro de trabajo del agente, notas, observaciones, errores, briefing y tus revisiones anteriores. " +
      "Con since (fecha ISO) solo lo posterior a esa fecha (útil a mitad de misión). Sin since incluye `counterfactuals`: para cada " +
      "operación cerrada, con el precio real minuto a minuto, cuánto llegó a subir mientras la tenía y qué habría dado mantenerla 15 o " +
      "30 min más (en una misión rápida, 1, 3 y 5). Sirve para distinguir una mala entrada de una mala salida. En una misión rápida, twin es " +
      "su gemelo mecánico (los eventos siguientes con la regla sin inteligencia, en la misma franja; observation dice qué parte del tiempo que " +
      "estuvo abierto se cotizó de verdad), agentEntry la entrada del agente con su ficha, los dos con `candles` (velas de 1 min del pool: si tocó la toma " +
      "de beneficio, en cuántos minutos, lo más bajo antes y lo más alto; la misma vara para los dos, se mide unos minutos después de su plazo) " +
      "y missionClass, cómo va su clase (también con velas).",
    schema: z.object({ mission_id: z.number().int(), since: z.string().optional() }),
    run: async ({ mission_id, since }) => {
      // Las velas de las entradas de esta misión cuyo plazo ya terminó, si faltan (pocas peticiones, sin hacer cola delante de nadie).
      const { checkCandleOutcomes } = await import("../sim/candles.js");
      await checkCandleOutcomes({ missionIds: [mission_id], maxRequests: 4 }).catch(() => []);
      const data = memory.missionReviewData(mission_id, since);
      if (since) return toText(data);
      const { missionCounterfactuals } = await import("../sim/counterfactuals.js");
      return toText({ ...data, counterfactuals: await missionCounterfactuals(mission_id).catch((e) => [{ unavailable: (e as Error).message }]) });
    },
  }),
  tool({
    name: "memory_catalog",
    kind: "memory",
    role: "reviewer",
    description:
      "La memoria tal como la ve el agente, ordenada por parecido con la misión indicada o la activa. Por defecto, compacta: howtos por " +
      "título y creencias recortadas con su evidencia calculada. Con howto_ids y belief_ids, el detalle de esos; con full: true, todo (largo).",
    schema: z.object({
      mission_id: z.number().int().optional(),
      howto_ids: z.array(z.number().int()).optional(),
      belief_ids: z.array(z.number().int()).optional(),
      full: z.boolean().default(false),
    }),
    run: async ({ mission_id, howto_ids, belief_ids, full }, ctx) =>
      toText(memory.memoryCatalog(mission_id ?? ctx.missionId, { howtoIds: howto_ids, beliefIds: belief_ids, full })),
  }),
  tool({
    name: "wait_for_activity",
    kind: "memory",
    role: "reviewer",
    description:
      `Espera (1-${MAX_WAIT_MINUTES} minutos) a que haya algo que revisar en la misión activa. Vuelve antes si la misión termina ` +
      "(reason: mission_ended), si toca la revisión periódica (interval_due) o si el agente ha acumulado actividad (activity); en " +
      "esos dos casos trae `checkpoint` con todo lo de la revisión (lo nuevo desde la anterior, las creencias que tocan las posiciones " +
      "nuevas, los howtos por título y los errores sin howto). Si no, reason: timeout.",
    schema: z.object({ max_minutes: z.number().min(1).max(MAX_WAIT_MINUTES).default(MAX_WAIT_MINUTES) }),
    run: async ({ max_minutes }) => {
      const r = await memory.waitForActivity(max_minutes);
      if ((r.reason === "interval_due" || r.reason === "activity") && r.missionId !== undefined) {
        return toText({ ...r, checkpoint: memory.checkpointData(r.missionId) });
      }
      return json(r);
    },
  }),
  tool({
    name: "write_howto",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description:
      "Guarda conocimiento procedimental: cómo se hace algo en el simulador o en el mercado, qué falla y cómo evitarlo. " +
      "scope: la cadena o exchange (solana, base, bsc, binance) o 'any'. Con fixes_error_ids lo vinculas a los errores que resuelve. " +
      "Si ya hay uno casi igual, se rechaza: actualízalo con update_howto.",
    schema: z.object({
      scope: z.string().min(1),
      topic: z.string().min(1).describe("Tema corto: 'órdenes condicionales', 'transferencias', 'comisiones'…"),
      title: z.string().min(1),
      steps: z.string().min(1).describe("Pasos concretos o regla práctica, con los datos que la respaldan"),
      mission_id: z.number().int().optional().describe("Misión de la que sale"),
      fixes_error_ids: z.array(z.number().int()).optional(),
    }),
    run: async (i) => {
      const id = memory.writeHowto({ scope: i.scope, topic: i.topic, title: i.title, steps: i.steps, missionId: i.mission_id ?? null, fixesErrorIds: i.fixes_error_ids });
      return `Howto #${id} guardado.`;
    },
  }),
  tool({
    name: "update_howto",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description: "Corrige un howto, o márcalo obsoleto (status: obsolete, con superseded_by si otro lo sustituye).",
    schema: z.object({
      id: z.number().int(),
      title: z.string().optional(),
      steps: z.string().optional(),
      status: z.enum(["active", "obsolete"]).optional(),
      superseded_by: z.number().int().optional(),
      fixes_error_ids: z.array(z.number().int()).optional(),
    }),
    run: async (i) => {
      memory.updateHowto({ id: i.id, title: i.title, steps: i.steps, status: i.status, supersededBy: i.superseded_by, fixesErrorIds: i.fixes_error_ids });
      return `Howto #${i.id} actualizado.`;
    },
  }),
  tool({
    name: "write_belief",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description:
      "Guarda una creencia sobre el mercado (una hipótesis, no un hecho). Si puedes expresarla como condición sobre los datos de entrada " +
      "de las posiciones, añádela: el simulador la contrastará con todas las operaciones pasadas y futuras (devuelve el resultado al momento). " +
      `Campos de la condición: ${memory.CONDITION_FIELDS.join(", ")}. Con condición, expectation dice si cumplirla tiende a ganar (positive) o a perder (negative). ` +
      "Si ya hay una casi igual o con la misma condición, se rechaza: corrígela con revise_belief.",
    schema: z.object({
      statement: z.string().min(1).describe("La creencia, con los datos que la originan"),
      applies_to: z.string().min(1).describe("A qué misiones o situaciones se aplica"),
      expectation: z.enum(["positive", "negative"]).optional(),
      condition: conditionSchema.optional(),
      mission_id: z.number().int().optional().describe("Misión de la que sale"),
    }),
    run: async (i) =>
      json(memory.writeBelief({ statement: i.statement, appliesTo: i.applies_to, expectation: i.expectation, condition: i.condition, missionId: i.mission_id ?? null })),
  }),
  tool({
    name: "revise_belief",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description:
      "Corrige una creencia (texto, alcance, condición o expectativa) o retírala (retire: true) cuando los datos la contradigan. " +
      "No se borra: queda retirada con su motivo. Devuelve su evidencia recalculada.",
    schema: z.object({
      id: z.number().int(),
      statement: z.string().optional(),
      applies_to: z.string().optional(),
      expectation: z.enum(["positive", "negative"]).optional(),
      condition: conditionSchema.optional(),
      clear_condition: z.boolean().optional(),
      retire: z.boolean().optional(),
      reason: z.string().min(1).describe("Por qué la cambias"),
    }),
    run: async (i) =>
      json(
        memory.reviseBelief({
          id: i.id,
          statement: i.statement,
          appliesTo: i.applies_to,
          expectation: i.expectation,
          condition: i.condition,
          clearCondition: i.clear_condition,
          retire: i.retire,
          reason: i.reason,
        }),
      ),
  }),
  tool({
    name: "convert_belief_to_howto",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description: "Convierte en howto una creencia que en realidad es conocimiento procedimental (cómo funciona algo), no una hipótesis de mercado.",
    schema: z.object({ id: z.number().int(), scope: z.string().min(1), topic: z.string().min(1), title: z.string().min(1), steps: z.string().min(1) }),
    run: async (i) => `Creencia #${i.id} convertida en el howto #${memory.convertBeliefToHowto(i)}.`,
  }),
  tool({
    name: "resolve_observation",
    kind: "memory",
    role: "reviewer",
    description: "Marca una observación del agente como usada (pasó a la memoria) o descartada, con una nota.",
    schema: z.object({ id: z.number().int(), status: z.enum(["used", "dismissed"]), note: z.string().min(1) }),
    run: async ({ id, status, note }) => {
      memory.resolveObservation(id, status, note);
      return `Observación #${id}: ${status}.`;
    },
  }),
  tool({
    name: "write_mission_review",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description:
      "Retrospectiva de una misión terminada: qué se intentó, qué pasó (con cifras), qué sorprendió y qué conviene hacer la próxima vez. " +
      "Devuelve las estadísticas de la misión calculadas por el simulador.",
    schema: z.object({
      mission_id: z.number().int(),
      what_was_tried: z.string().min(1),
      what_happened: z.string().min(1),
      surprises: z.string().optional(),
      next_time: z.string().min(1),
    }),
    run: async (i) =>
      json(memory.writeMissionReview({ missionId: i.mission_id, whatWasTried: i.what_was_tried, whatHappened: i.what_happened, surprises: i.surprises, nextTime: i.next_time })),
  }),
  tool({
    name: "revise_mission_review",
    kind: "memory",
    role: "reviewer",
    journaled: true,
    description:
      "Corrige una retrospectiva ya escrita: solo los campos que indiques (el resto se queda igual), con el motivo. Para cifras " +
      "equivocadas, conclusiones que los datos posteriores desmienten o lo que faltó decir.",
    schema: z.object({
      mission_id: z.number().int(),
      what_was_tried: z.string().min(1).optional(),
      what_happened: z.string().min(1).optional(),
      surprises: z.string().min(1).optional(),
      next_time: z.string().min(1).optional(),
      reason: z.string().min(1).describe("Qué corriges y por qué"),
    }),
    run: async (i) =>
      json(
        memory.reviseMissionReview({
          missionId: i.mission_id,
          whatWasTried: i.what_was_tried,
          whatHappened: i.what_happened,
          surprises: i.surprises,
          nextTime: i.next_time,
          reason: i.reason,
        }),
      ),
  }),
  tool({
    name: "mark_mission_reviewed",
    kind: "memory",
    role: "reviewer",
    description: "Da por revisada una misión terminada que no llegó a tener operaciones (no hay nada que analizar).",
    schema: z.object({ mission_id: z.number().int(), note: z.string().min(1) }),
    run: async ({ mission_id, note }) => {
      memory.markEmptyMissionReviewed(mission_id, note);
      return `Misión #${mission_id} marcada como revisada.`;
    },
  }),
  tool({
    name: "review_checkpoint",
    kind: "memory",
    role: "reviewer",
    description:
      "Marca que has revisado la misión activa hasta ahora, con un resumen breve de lo que has visto y hecho. " +
      "La siguiente revisión partirá de aquí (mission_review_data con since).",
    schema: z.object({ mission_id: z.number().int(), summary: z.string().min(1) }),
    run: async ({ mission_id, summary }) => {
      memory.reviewCheckpoint(mission_id, summary);
      return "Revisión anotada.";
    },
  }),
  tool({
    name: "write_briefing",
    kind: "memory",
    role: "reviewer",
    description:
      "Escribe (o reescribe) el briefing de una misión: lo que el agente debe tener presente de su memoria para esa misión en concreto, " +
      "citando los ids de howtos y creencias. El agente lo recibe al empezar cada sesión y, si lo cambias a mitad de misión, en su siguiente acción. " +
      "Con append: true, el texto se añade al final del briefing actual (con la hora) en vez de sustituirlo: útil a mitad de misión, sin reescribir lo que ya había.",
    schema: z.object({ mission_id: z.number().int(), text: z.string().min(1), append: z.boolean().default(false) }),
    run: async ({ mission_id, text, append }) => {
      const current = append ? memory.getBriefing(mission_id)?.text : undefined;
      memory.writeBriefing(mission_id, current ? `${current}\n\nActualización (${now().slice(11, 16)} UTC): ${text}` : text);
      return `Briefing de la misión #${mission_id} ${current ? "ampliado" : "guardado"}.`;
    },
  }),

  // ─── Usuario: peticiones de capacidades ───────────────────────────────────
  tool({
    name: "capability_requests",
    kind: "misc",
    role: "user",
    description: "[Solo para el usuario] Capacidades que el agente ha pedido (cuentas, herramientas, datos, mercados), con cuántas veces y en qué misiones.",
    schema: z.object({ status: z.enum(["open", "all"]).default("open") }),
    run: async ({ status }) => json(memory.listCapabilityRequests(status)),
  }),
  tool({
    name: "resolve_capability_request",
    kind: "misc",
    role: "user",
    description: "[Solo para el usuario] Responde a una petición del agente: aceptada, rechazada o hecha, con una nota.",
    schema: z.object({ id: z.number().int(), status: z.enum(["accepted", "rejected", "done"]), response: z.string().min(1) }),
    run: async ({ id, status, response }) => {
      memory.resolveCapabilityRequest(id, status, response);
      return `Petición #${id}: ${status}.`;
    },
  }),

  // ─── Memoria entre sesiones y tiempo ──────────────────────────────────────
  tool({
    name: "write_note",
    kind: "memory",
    journaled: true,
    description: "Guarda una nota para ti mismo. Las notas se te muestran al empezar cada sesión futura.",
    schema: z.object({ text: z.string() }),
    run: async ({ text }, ctx) => {
      db.prepare("INSERT INTO notes (ts, mission_id, session_id, text) VALUES (?, ?, ?, ?)").run(now(), mid(ctx), ctx.sessionId, text);
      return "Nota guardada.";
    },
  }),
  tool({
    name: "delete_note",
    kind: "memory",
    journaled: true,
    description: "Borra una nota por su id cuando ya no sea útil.",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }, ctx) => {
      db.prepare("DELETE FROM notes WHERE id = ? AND mission_id = ?").run(id, mid(ctx));
      return "Nota borrada.";
    },
  }),
];

type AnyTool = (typeof SIM_TOOLS)[number];

/** Añade al resultado el briefing del revisor si ha cambiado desde la última vez que lo vio el agente. */
function withNews(content: ToolOutput, missionId: number | null): ToolOutput {
  if (missionId === null || typeof content !== "string") return content;
  const news = memory.takeBriefingNews(missionId);
  return news ? `${content}\n\n📌 El revisor ha actualizado tu briefing para esta misión:\n${news}` : content;
}

export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolCtx,
  tools: readonly AnyTool[] | readonly { name: string }[] = SIM_TOOLS,
): Promise<{ content: ToolOutput; isError: boolean }> {
  const def = (tools as readonly AnyTool[]).find((t) => t.name === name);
  if (!def) return { content: `Herramienta desconocida: ${name}`, isError: true };
  const fail = (message: string) => {
    // Los errores se guardan para que el revisor detecte los que se repiten y escriba cómo evitarlos.
    memory.recordToolError({ missionId: ctx.missionId, sessionId: ctx.sessionId, tool: name, input: rawInput, message });
    const howto = memory.howtoForError(message);
    const steps = howto ? (howto.steps.length > 600 ? howto.steps.slice(0, 600) + "…" : howto.steps) : "";
    return {
      content: `Error: ${message}` + (howto ? `

Tu memoria ya tiene un howto para este error: #${howto.id} «${howto.title}»
${steps}` : ""),
      isError: true,
    };
  };
  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) return fail(`Entrada no válida: ${parsed.error.message}`);
  const trading = def.kind === "trade";
  const notActive = async () => ({
    content: `Error: no hay ninguna misión activa. ${(await mission.missionStatus(ctx.missionId ?? undefined)).message ?? ""}`,
    isError: true,
  });
  const current = ctx.missionId !== null ? mission.getMission(ctx.missionId) : undefined;
  if (trading && current?.status !== "active") return notActive();
  const clockStopped = trading && !!current && !current.started_at;
  // Antes del reloj se puede preparar y esperar, pero no operar: sería tiempo gratis. Las herramientas con
  // startsClock (enter_with_exits) arrancan el reloj ellas mismas, igual que start_session; con una entrada (ToolDef.entry:
  // su compra), solo cuando esa operación se ha hecho, que es la única que se admite antes del reloj.
  if (clockStopped && !def.startsClock) return { content: `Error: ${CLOCK_NOT_STARTED}`, isError: true };
  const beliefs = (parsed.data as { thesis?: { beliefs_applied?: number[] } }).thesis?.beliefs_applied;
  if (beliefs?.length) {
    const unknown = memory.unknownBeliefs(beliefs);
    if (unknown.length) return fail(`Las creencias #${unknown.join(", #")} no existen o ya no están activas. Activas: ${memory.activeBeliefIds().map((id) => `#${id}`).join(", ") || "ninguna"}`);
  }
  // Antes de operar o de mirar la cartera, lo que ya ha llegado de una transferencia está disponible.
  if (trading || def.deliversNews) await transfers.settleTransfers({ missionId: ctx.missionId ?? undefined }).catch(() => []);
  const rejected = (message: string) => {
    if (trading) logJournal({ missionId: ctx.missionId, sessionId: ctx.sessionId, kind: "rejected", summary: `${name} rechazada: ${message}`, details: rawInput });
    return fail(message);
  };
  // Todo lo que se puede comprobar sin operar va antes del reloj: si falla, el reloj sigue parado (el executor espera
  // al siguiente evento gratis, en vez de con el reloj corriendo y sin posición).
  let prepared: unknown;
  if (def.preflight) {
    try {
      prepared = await (def.preflight as (i: unknown, c: ToolCtx) => Promise<unknown>)(parsed.data, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rejected(clockStopped ? `${message} (el reloj no ha arrancado)` : message);
    }
  }
  // La operación que arranca el reloj va antes que él: el reloj arranca solo si se hace, y a la hora en que se hizo. Si
  // falla no queda nada que deshacer (ni reloj, ni sesión, ni gemelo, ni plan asignado, ni plazo movido). En la M18 la
  // compra revertía con el reloj ya en marcha y el error no lo decía: el executor forzó otra entrada y perdió el 94 %.
  let entered: EntryResult | undefined;
  const journalMark = def.entry && clockStopped ? (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM journal").get() as { id: number }).id : 0;
  if (def.entry) {
    try {
      entered = await (def.entry as (i: unknown, c: ToolCtx, p: unknown) => Promise<EntryResult>)(parsed.data, ctx, prepared);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rejected(clockStopped && !/el reloj no ha arrancado/.test(message) ? `${message} (el reloj no ha arrancado)` : message);
    }
  }
  if (clockStopped) {
    const preClockSession = ctx.sessionId;
    if (entered) mission.startMissionClock(current.id, entered.clock);
    // La misión puede haber dejado de estar activa mientras se compraba (p. ej. create_mission la sustituye, o el usuario la
    // para): no se abre sesión ni se arranca nada, y menos en otra misión (la sesión de trabajo es la de ESTA misión).
    const endedMeanwhile = async () =>
      entered
        ? fail(`La compra se ha hecho, pero la misión ya no está activa: no se ha puesto la toma de beneficio. ${(await mission.missionStatus(current.id)).message ?? ""}`)
        : notActive();
    if (mission.getMission(current.id)?.status !== "active") return endedMeanwhile();
    if (ctx.startClock) ctx = { ...ctx, sessionId: await ctx.startClock(current.id) };
    else if (!entered) mission.startMissionClock(current.id);
    // Lo que la entrada dejó en el diario (la compra) va en la sesión de trabajo que abre el reloj, como si se hubiera
    // abierto antes: la sesión se abre solo con la compra hecha. Solo a una sesión de esta misión.
    const sessionMission = (db.prepare("SELECT mission_id FROM sessions WHERE id = ?").get(ctx.sessionId) as { mission_id: number | null } | undefined)?.mission_id;
    if (entered && ctx.sessionId !== preClockSession && sessionMission === current.id) {
      db.prepare("UPDATE journal SET session_id = ? WHERE mission_id = ? AND id > ? AND session_id IS ?").run(ctx.sessionId, current.id, journalMark, preClockSession);
    }
    if (mission.getMission(current.id)?.status !== "active") return endedMeanwhile();
  }
  if (def.researchTarget) {
    const target = (def.researchTarget as (i: unknown) => string | string[] | undefined)(parsed.data);
    for (const t of Array.isArray(target) ? target : [target]) positions.logResearch(ctx.missionId, name, t?.trim() || undefined);
  }
  try {
    let content = await (def.run as (i: unknown, c: typeof ctx, p: unknown, e: unknown) => Promise<ToolOutput>)(parsed.data, ctx, prepared, entered);
    if (trading) {
      // Tras cada operación se comprueba si ya se ha alcanzado el objetivo.
      const ended = await mission.checkMission(ctx.missionId ?? undefined).catch(() => []);
      if (ended.length && typeof content === "string") content = `${content}\n\n${ended.join("\n")}`;
    }
    if (trading || def.deliversNews) content = withNews(content, ctx.missionId);
    return { content, isError: false };
  } catch (err) {
    return rejected(err instanceof Error ? err.message : String(err));
  }
}
