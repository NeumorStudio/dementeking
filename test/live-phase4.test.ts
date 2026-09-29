// Modo real, fase 4: ritmo máximo de operaciones, parada automática por pérdida máxima y exportación fiscal.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "../src/config.js";
import { db, logJournal, now } from "../src/db.js";
import { exportTaxes } from "../src/live/taxes.js";
import { createSignerServer, MAX_OPS_PER_MINUTE } from "../src/live/signer/server.js";
import { checkMission, createLiveMission, getMission } from "../src/sim/mission.js";
import { installFakeMarket } from "./fake-market.js";

installFakeMarket();

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mission = (usdc = 100) =>
  createLiveMission({
    holdings: [{ venue: "solana", asset: USDC, symbol: "USDC", decimals: 6, amount: usdc }],
    totalUsd: 100,
    byChain: { solana: 100, base: 0, bsc: 0 },
    targetPct: 10,
    durationMinutes: 60,
    approval: "auto",
    limits: { maxTradeUsd: 25, maxLossPct: 30 },
  });

test("el firmante frena un bucle: como mucho N operaciones por minuto", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-rate-"));
  const token = "d".repeat(64);
  const signer = createSignerServer({ dir, token, deps: { walletValueUsd: async () => 100 } });
  const port = await signer.listen();
  after(() => signer.server.close());
  const origin = `http://127.0.0.1:${port}`;
  await fetch(origin + "/wallet/create", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "contraseña de prueba" }) });
  const m = mission();
  const intent = () =>
    fetch(origin + "/api/intent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ missionId: m.id, chain: "solana", side: "buy", usd: 5, summary: "x" }),
    }).then((r) => r.status);
  for (let i = 0; i < MAX_OPS_PER_MINUTE; i++) assert.equal(await intent(), 200);
  assert.equal(await intent(), 429);
});

test("al llegar a la pérdida máxima, la misión real se para sola", async () => {
  // Cartera pública de prueba: las RPC del mercado falso no responden, así que se conservan los saldos de la misión.
  mkdirSync(path.join(config.dataDir, "live"), { recursive: true });
  writeFileSync(
    path.join(config.dataDir, "live", "wallet.json"),
    JSON.stringify({ version: 1, createdAt: now(), evm: "0x695e7aE1E234bff3B0D0668240Fdf52D50b9a5bf", solana: "2pWz5Gymx8Voz6JM3nbWUScxXdvyNaKBW3NcgAgG3wsQ" }),
  );
  const m = mission(60);
  const log = await checkMission(m.id);
  assert.match(log.join("\n"), /PARADA POR PÉRDIDA MÁXIMA/);
  assert.equal(getMission(m.id)!.status, "expired");
});

test("exportación fiscal: operaciones reales con hash y resultados por posición, en CSV para Excel", async () => {
  const m = mission();
  logJournal({
    missionId: m.id,
    sessionId: null,
    kind: "swap",
    summary: "Swap REAL 10 USDC → 100000 MEME",
    details: { chain: "solana", soldQty: 10, soldSymbol: "USDC", receivedQty: 100000, receivedSymbol: "MEME", valueUsd: 10, networkFee: "0.000005 SOL", txHash: "5abc", explorer: "https://solscan.io/tx/5abc" },
  });
  db.prepare(
    `INSERT INTO positions (mission_id, venue, asset, symbol, opened_at, closed_at, status, qty_open, cost_open_usd, realized_cost_usd, realized_proceeds_usd, entry_features, research)
     VALUES (?, 'solana', 'MeMe', 'MEME', ?, ?, 'closed', 0, 0, 10, 12.5, '{}', '{}')`,
  ).run(m.id, now(), now());
  const r = await exportTaxes();
  assert.ok(r.operations >= 1);
  assert.equal(r.realizedUsd, 2.5);
  const ops = readFileSync(r.files[0]!, "utf8");
  assert.ok(ops.startsWith("﻿fecha_utc;mision;cadena;tipo"));
  assert.match(ops, /permuta \(swap\);10;USDC;100000;MEME;10;/);
  assert.match(ops, /5abc/);
  // Las misiones simuladas no aparecen.
  assert.doesNotMatch(ops, /Swap 10 USDC/);
});
