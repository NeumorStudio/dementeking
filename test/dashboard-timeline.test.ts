// La radio del panel lee también las sesiones lanzadas con --agent (claude -p … --agent dementeking:executor): su
// transcripción es el hilo principal de una sesión, con el agente en la primera línea. Las herramientas del simulador
// se cuentan con palabras, y lo que el diario repite de ellas no sale dos veces.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "dementeking-claude-"));
process.env.CLAUDE_CONFIG_DIR = home;
delete process.env.CRYPTOAGENT_HOST;
const project = path.join(home, "projects", "C--tf-tmp-dk-run");
mkdirSync(project, { recursive: true });

const T0 = Date.parse("2026-09-30T10:32:30.000Z");
const ts = (s: number) => new Date(T0 + s * 1000).toISOString();
const P = "mcp__plugin_dementeking_cryptosim__";
const MINT = "Agky2fiKttQ6SiKuQTxZZuAUDgxfiMD1TMtGHqGxpump";
let uuid = 0;
const use = (s: number, id: string, name: string, input: object) => ({ type: "assistant", uuid: `u${++uuid}`, timestamp: ts(s), message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (s: number, id: string, text: string, isError = false) => ({
  type: "user",
  uuid: `u${++uuid}`,
  timestamp: ts(s),
  message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], ...(isError ? { is_error: true } : {}) }] },
});
const say = (s: number, text: string) => ({ type: "assistant", uuid: `u${++uuid}`, timestamp: ts(s), message: { content: [{ type: "text", text }] } });
const session = (file: string, agent: string | null, prompt: string, lines: object[], ended: boolean, start = 0) =>
  writeFileSync(
    path.join(project, file),
    [
      ...(agent ? [{ type: "agent-setting", agentSetting: agent, sessionId: file }] : []),
      { type: "queue-operation", operation: "enqueue", timestamp: ts(start), sessionId: file, content: prompt },
      { type: "user", uuid: `u${++uuid}`, timestamp: ts(start + 1), sessionId: file, message: { role: "user", content: prompt } },
      ...lines,
      ...(ended ? [{ type: "cost-state", sessionId: file, totalCostUSD: 0.1901516, totalDuration: 922_536 }] : []),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

session(
  "exec-1.jsonl",
  "dementeking:executor",
  "Ejecuta el plan vigente.",
  [
    use(5, "t1", `${P}get_plan`, {}),
    result(6, "t1", "planId: 1"),
    use(7, "t2", `${P}wait_for_signal`, {}),
    result(285, "t2", "Sin señal en 278 s (23 vueltas). Tokens frescos vistos: 2; descartes: launchpad met-dbc ×2. Vuelve a llamar a wait_for_signal."),
    use(286, "t3", `${P}wait_for_signal`, {}),
    result(300, "t3", `signal: Fomo Cat pasa los filtros del plan #1\ntoken: ${MINT}\nsymbol: Fomo Cat\npoolAgeSeconds: 22`),
    say(301, "Entrando ya en Fomo Cat."),
    use(302, "t4", `${P}enter_with_exits`, { token: MINT, thesis: { plan_ref: 1 } }),
    result(309, "t4", JSON.stringify({ clock: { minutesLeft: 9.9 }, buy: { received: "127239.52841 Fomo Cat" } })),
    use(310, "t5", `${P}wait`, { minutes: 4.5 }),
    result(345, "t5", "Han pasado 0.6 min (vuelvo antes: la misión ha terminado). Hora: x\nNovedades:\n- …"),
    use(346, "t6", `${P}entry_dataset`, {}),
    result(347, "t6", "…"),
    say(350, "Misión conseguida."),
  ],
  true,
);
// El cerebro, todavía escribiendo (sin cost-state); una sesión normal de Claude Code (sin agente) no sale.
session("plan-1.jsonl", "dementeking:planner", "Prepara el plan.", [use(400, "p1", `${P}write_plan`, { event: "token recién graduado" })], false, 390);
session("normal.jsonl", null, "hola", [say(410, "esto es de otra sesión")], false, 405);

const { db } = await import("../src/db.js");
const { agentSessions, signalSymbols, timeline } = await import("../src/dashboard/timeline.js");

test("radio: la sesión del ejecutor lanzada con --agent, con sus pasos y sus herramientas contadas con palabras", () => {
  const events = timeline(ts(-60), null);
  const titles = events.map((e) => [e.kind, e.agent ?? null, e.title]);
  assert.deepEqual(titles, [
    ["step", "executor", "El ejecutor empieza: «Ejecuta el plan vigente.»"],
    ["tool", "executor", "Lee el plan vigente"],
    ["tool", "executor", "Espera la señal: sin señal en 278 s (23 vueltas) · 2 tokens vistos"],
    ["signal", "executor", "Señal: Fomo Cat pasa los filtros del plan #1 (pool de 22 s)"],
    ["text", "executor", "Entrando ya en Fomo Cat."],
    ["tool", "executor", "Entra en Fomo Cat: compra hecha, toma de beneficio puesta y reloj en marcha"],
    ["tool", "executor", "Espera 4.5 min: vuelve a los 0.6 min, la misión ha terminado"],
    ["tool", "executor", "Repasa las entradas medidas: su ficha y su resultado con velas"],
    ["text", "executor", "Misión conseguida."],
    ["step", "executor", "El ejecutor termina · 15 min · 0,19 $ de modelo"],
    ["step", "planner", "El cerebro empieza: «Prepara el plan.»"],
    ["tool", "planner", "Escribe un plan nuevo: token recién graduado"],
  ]);
  // La espera guarda cuándo volvió (dura minutos) y el nombre del token de la señal se reutiliza en la entrada.
  const wait = events.find((e) => e.tool === "wait_for_signal")!;
  assert.equal(wait.endTs, ts(285));
  assert.deepEqual(signalSymbols(ts(-60)), { [MINT]: "Fomo Cat" });
});

test("radio: quién está trabajando (el cerebro, sin terminar) y quién ya terminó (el ejecutor)", () => {
  // El orden es el de su última escritura (la hora del archivo cuenta): aquí se escribieron a la vez, así que por agente.
  const sessions = agentSessions(ts(-60)).sort((a, b) => a.agent.localeCompare(b.agent));
  assert.deepEqual(
    sessions.map((s) => [s.agent, s.main, s.ended, s.prompt]),
    [
      ["executor", true, true, "Ejecuta el plan vigente."],
      ["planner", true, false, "Prepara el plan."],
    ],
  );
  assert.equal(sessions[0]!.startedAt, ts(0));
  assert.equal(sessions[1]!.startedAt, ts(390));
});

test("radio: la espera sin señal del diario no sale dos veces si ya está la llamada con su resultado", () => {
  const mission = Number(
    db
      .prepare("INSERT INTO missions (created_at, requested_at, initial_usd, target_usd, deadline, status, mode, class) VALUES (?, ?, 50, 62.5, ?, 'active', 'sim', 'graduado-10m-+25%')")
      .run(ts(0), ts(0), ts(600)).lastInsertRowid,
  );
  const journal = db.prepare("INSERT INTO journal (ts, mission_id, kind, summary) VALUES (?, ?, ?, ?)");
  journal.run(ts(285.2), mission, "signal", "wait_for_signal (plan #1): Sin señal en 278 s (23 vueltas).");
  // Una espera del diario sin llamada en la transcripción (p. ej. de otra sesión que no se lee) sí sale.
  journal.run(ts(900), mission, "signal", "wait_for_signal (plan #1): Sin señal en 270 s (22 vueltas).");
  journal.run(ts(0), mission, "mission", "Misión iniciada");
  const fromDb = timeline(ts(-60), mission).filter((e) => e.id.startsWith("j"));
  assert.deepEqual(
    fromDb.map((e) => e.title),
    ["Misión iniciada", "wait_for_signal (plan #1): Sin señal en 270 s (22 vueltas)."],
  );
});

test("radio: el motivo de volver antes de wait con paréntesis (token y movimiento delante), y la compra hecha sin toma de beneficio no suena a rechazo", () => {
  // Se escribe aquí (y no arriba) para no cambiar las listas de las pruebas anteriores, que leen todas las sesiones.
  session(
    "exec-2.jsonl",
    "dementeking:executor",
    "Ejecuta el plan vigente.",
    [
      use(2005, "w1", `${P}wait`, { minutes: 4.5 }),
      result(2047, "w1", "Han pasado 0.7 min (vuelvo antes: JOKERINU (solana) se ha movido un -79.4 %). Hora: 2026-09-30T11:06:17.000Z\nSin novedades en tus órdenes ni transferencias."),
      use(2050, "w2", `${P}wait`, { minutes: 4.5 }),
      result(
        2110,
        "w2",
        "Espera acortada a 1 minuto: estás parado en efectivo y lejos del objetivo.\nHan pasado 1 min (vuelvo antes: PEPE (base) se ha movido un +12 %). Hora: x\nSin novedades en tus órdenes ni transferencias.",
      ),
      use(2120, "e1", `${P}enter_with_exits`, { token: MINT }),
      result(
        2127,
        "e1",
        "La compra de Fomo Cat SÍ se ha hecho (127240 tokens por 48.5 USDC) y el reloj corre desde ella, pero la toma de beneficio no se ha podido calcular ni poner (sin cotización de venta (Jupiter 429)). Ponla con place_swap_trigger_order",
        true,
      ),
      use(2130, "e2", `${P}enter_with_exits`, { token: MINT }),
      result(2131, "e2", "Error: la ida y vuelta cuesta un 14 % (máximo 10 %). No se ha comprado nada.", true),
    ],
    false,
    2000,
  );
  const events = timeline(ts(1990), null).filter((e) => e.tool);
  assert.deepEqual(
    events.map((e) => [e.kind, e.title]),
    [
      ["tool", "Espera 4.5 min: JOKERINU -79.4 % a los 0.7 min"],
      ["tool", "Espera 4.5 min: PEPE +12 % a los 1 min"],
      // El aviso sigue en rojo (error): hay posición y el reloj corre sin toma de beneficio.
      ["error", "Entra en Fomo Cat sin toma de beneficio: sin cotización de venta (Jupiter 429)"],
      ["error", "No entra: la ida y vuelta cuesta un 14 % (máximo 10 %)."],
    ],
  );
});
