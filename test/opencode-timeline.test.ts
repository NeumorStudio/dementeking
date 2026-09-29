// El panel lee la transcripción del agente de las sesiones de OpenCode cuando corre en OpenCode.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Una base de datos con la forma de la de OpenCode 2: una sesión del trader y otra de otro agente.
const file = path.join(mkdtempSync(path.join(os.tmpdir(), "dementeking-oc-")), "opencode.db");
const oc = new DatabaseSync(file);
oc.exec(`
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, agent TEXT);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
  INSERT INTO session_v2 VALUES ('s1', 'trader'), ('s2', 'build');
`);
const t0 = Date.now();
const msg = (id: string, session: string, seq: number, content: unknown[]) =>
  oc.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?)").run(id, session, seq, t0 + seq * 1000, JSON.stringify({ content }));
msg("m1", "s1", 1, [
  { type: "reasoning", text: "pienso" },
  { type: "text", text: "Voy a escanear Solana" },
  {
    type: "tool",
    name: "execute",
    state: {
      status: "completed",
      input: { code: "const a = await tools.cryptosim.scan_market({ chain: 'solana', limit: 10 });\nconst b = await tools.cryptosim.http_get({ url: 'https://x.test/api' });" },
      content: [{ type: "text", text: "resultado del bloque" }],
      metadata: { toolCalls: [{ tool: "cryptosim.scan_market" }, { tool: "cryptosim.http_get" }] },
    },
  },
]);
msg("m2", "s1", 2, [{ type: "tool", name: "webfetch", state: { status: "completed", input: { url: "https://dexscreener.com" }, content: "página" } }]);
msg("m3", "s1", 3, [{ type: "tool", name: "execute", state: { status: "completed", input: { code: "await tools.cryptosim.log_progress({entry:'x'})" }, metadata: { toolCalls: [{ tool: "cryptosim.log_progress" }] } } }]);
msg("m4", "s2", 4, [{ type: "text", text: "esto es de otro agente" }]);

process.env.OPENCODE_DB = file;
process.env.CRYPTOAGENT_HOST = "opencode";
const { timeline } = await import("../src/dashboard/timeline.js");

test("transcripción de OpenCode: textos, llamadas al simulador con sus argumentos y lecturas web", () => {
  const events = timeline(new Date(t0 - 60_000).toISOString(), null);
  assert.deepEqual(
    events.map((e) => [e.kind, e.title]),
    [
      ["text", "Voy a escanear Solana"],
      ["tool", "Consulta scan market"],
      ["fetch", "Consulta https://x.test/api"],
      ["fetch", "Lee https://dexscreener.com"],
    ],
  );
  // El resultado de un execute con varias llamadas va en la última; log_progress ya sale del diario; otros agentes, fuera.
  assert.equal(events[2]!.body, "resultado del bloque");
  assert.equal(events[1]!.body, undefined);
});
