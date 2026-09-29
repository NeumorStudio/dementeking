// Modo real: política del firmante, límites, cola de aprobación y que las herramientas no mezclen modos.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import { checkEvmTx, checkLimits, checkSolanaSpend, checkSolanaTx, JUPITER_PROGRAM, type AccountState } from "../src/live/policy.js";
import { createSignerServer } from "../src/live/signer/server.js";
import { createLiveMission, type Mission } from "../src/sim/mission.js";
import { runTool } from "../src/tools/index.js";
import { db } from "../src/db.js";
import { valuation } from "../src/sim/portfolio.js";
import { settleTransfers } from "../src/sim/transfers.js";
import { installFakeMarket } from "./fake-market.js";

installFakeMarket();

// ─── Política Solana ────────────────────────────────────────────────────────

const owner = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const wsolAta = PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN.toBuffer(), new PublicKey("So11111111111111111111111111111111111111112").toBuffer()],
  ATA,
)[0];

function tx(payer: PublicKey, ixs: TransactionInstruction[]) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}
const jupiterIx = new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys: [{ pubkey: owner, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });

test("Solana: un swap de Jupiter que envuelve SOL en la propia cuenta se acepta", () => {
  const wrap = SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: 1000 });
  assert.deepEqual(checkSolanaTx(tx(owner, [wrap, jupiterIx]), owner.toBase58()), []);
});

test("Solana: se rechaza enviar SOL o tokens a otra cartera, programas desconocidos y otro pagador", () => {
  const steal = SystemProgram.transfer({ fromPubkey: owner, toPubkey: stranger, lamports: 1000 });
  assert.match(checkSolanaTx(tx(owner, [steal]), owner.toBase58()).join(), /no es de la IA/);
  const tokenTransfer = new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: stranger, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 1]),
  });
  assert.match(checkSolanaTx(tx(owner, [tokenTransfer]), owner.toBase58()).join(), /instrucción de token no permitida/);
  const weird = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
  assert.match(checkSolanaTx(tx(owner, [weird]), owner.toBase58()).join(), /programa no permitido/);
  assert.match(checkSolanaTx(tx(stranger, [jupiterIx]), owner.toBase58()).join(), /quien paga/);
});

// ─── Política EVM ───────────────────────────────────────────────────────────

const ME = "0x695e7aE1E234bff3B0D0668240Fdf52D50b9a5bf";
const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

test("EVM: swap en el router de Kyber hacia la propia cartera sí; otro contrato u otro destinatario no", () => {
  const data = `0xe21fd0e9${"0".repeat(64)}${pad(ME)}${"0".repeat(64)}`;
  const l = { maxValue: 0n };
  assert.deepEqual(checkEvmTx({ chainId: 8453, to: KYBER, data, value: "0" }, "swap", ME, l), []);
  assert.match(checkEvmTx({ chainId: 8453, to: "0x000000000000000000000000000000000000dead", data, value: "0" }, "swap", ME, l).join(), /contrato no permitido/);
  assert.match(checkEvmTx({ chainId: 8453, to: KYBER, data: `0xe21fd0e9${"0".repeat(128)}`, value: "0" }, "swap", ME, l).join(), /destinatario/);
  assert.match(checkEvmTx({ chainId: 1, to: KYBER, data, value: "0" }, "swap", ME, l).join(), /cadena no permitida/);
  // No puede llevar más nativo del que se vende.
  assert.match(checkEvmTx({ chainId: 8453, to: KYBER, data, value: "1000" }, "swap", ME, { maxValue: 999n }).join(), /más nativo/);
});

const LIFI = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
test("EVM: un puente solo va al contrato de Li.Fi, con tope de nativo y, entre cadenas EVM, hacia la propia cartera", () => {
  const data = `0xabcdef01${pad(ME)}${"0".repeat(64)}`;
  assert.deepEqual(checkEvmTx({ chainId: 8453, to: LIFI, data, value: "0x0" }, "bridge", ME, { maxValue: 0n, destEvm: true }), []);
  assert.match(checkEvmTx({ chainId: 8453, to: KYBER, data, value: "0" }, "bridge", ME, { maxValue: 0n }).join(), /solo puede ir al contrato de Li.Fi/);
  assert.match(checkEvmTx({ chainId: 8453, to: LIFI, data, value: "5000" }, "bridge", ME, { maxValue: 4999n }).join(), /más nativo/);
  assert.match(checkEvmTx({ chainId: 8453, to: LIFI, data: `0xabcdef01${"0".repeat(128)}`, value: "0" }, "bridge", ME, { maxValue: 0n, destEvm: true }).join(), /destinatario/);
  // El approve a Li.Fi también se admite (cantidad exacta).
  assert.deepEqual(checkEvmTx({ chainId: 8453, to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", data: `0x095ea7b3${pad(LIFI)}${(10n ** 7n).toString(16).padStart(64, "0")}`, value: "0" }, "approve", ME), []);
});

test("Solana: un puente admite el programa de la ruta; lo que baja en la cartera, simulado, no puede superar lo aprobado", () => {
  const bridgeProgram = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: owner, isSigner: true, isWritable: true }], data: Buffer.from([9]) });
  assert.match(checkSolanaTx(tx(owner, [bridgeProgram]), owner.toBase58()).join(), /programa no permitido/);
  assert.deepEqual(checkSolanaTx(tx(owner, [bridgeProgram]), owner.toBase58(), { bridge: true }), []);

  const me = owner.toBase58();
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const pre = [
    { address: me, lamports: 100_000_000n },
    { address: "usdcAcc", lamports: 2_000_000n, mint: USDC, amount: 50_000_000n },
    { address: "bonkAcc", lamports: 2_000_000n, mint: BONK, amount: 1_000n },
  ];
  const budget = { lamports: 10_000_000n, tokens: { [USDC]: 20_000_000n } };
  const after = (sol: bigint, usdc: bigint | null, bonk: bigint) =>
    new Map<string, AccountState | null>([
      [me, { address: me, lamports: sol }],
      ["usdcAcc", usdc === null ? null : { address: "usdcAcc", lamports: 2_000_000n, mint: USDC, amount: usdc }],
      ["bonkAcc", { address: "bonkAcc", lamports: 2_000_000n, mint: BONK, amount: bonk }],
    ]);
  assert.deepEqual(checkSolanaSpend(me, pre, after(95_000_000n, 30_000_000n, 1_000n), budget), []);
  assert.match(checkSolanaSpend(me, pre, after(95_000_000n, 20_000_000n, 1_000n), budget).join(), /más de lo aprobado/);
  assert.match(checkSolanaSpend(me, pre, after(95_000_000n, 30_000_000n, 0n), budget).join(), new RegExp(BONK));
  assert.match(checkSolanaSpend(me, pre, after(80_000_000n, 30_000_000n, 1_000n), budget).join(), /lamports/);
  // Una cuenta que desaparece cuenta como vaciada.
  assert.match(checkSolanaSpend(me, pre, after(95_000_000n, null, 1_000n), budget).join(), /más de lo aprobado/);
});

test("EVM: approve solo al router y por una cantidad exacta", () => {
  const approve = (spender: string, amount: bigint) => `0x095ea7b3${pad(spender)}${amount.toString(16).padStart(64, "0")}`;
  assert.deepEqual(checkEvmTx({ chainId: 56, to: "0x55d398326f99059ff775485246999027b3197955", data: approve(KYBER, 10n ** 18n), value: "0" }, "approve", ME), []);
  assert.match(checkEvmTx({ chainId: 56, to: "0x55d3", data: approve(KYBER, (1n << 256n) - 1n), value: "0" }, "approve", ME).join(), /ilimitado/);
  assert.match(checkEvmTx({ chainId: 56, to: "0x55d3", data: approve("0x000000000000000000000000000000000000dead", 5n), value: "0" }, "approve", ME).join(), /no permitido/);
});

test("límites: máximo por operación y, por debajo de la pérdida máxima, solo vender", () => {
  const base = { maxTradeUsd: 10, maxLossPct: 30, initialUsd: 100, currentUsd: 95 };
  assert.deepEqual(checkLimits({ ...base, side: "buy", usd: 10 }), []);
  assert.match(checkLimits({ ...base, side: "buy", usd: 12 }).join(), /máximo por operación/);
  assert.match(checkLimits({ ...base, side: "buy", usd: 5, currentUsd: 69 }).join(), /pérdida máxima/);
  assert.deepEqual(checkLimits({ ...base, side: "sell", usd: 50, currentUsd: 10 }), []);
});

// ─── Firmante: intención, aprobación y firma ────────────────────────────────

const holdings = [{ venue: "solana" as const, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, amount: 100 }];
function liveMission(approval: "manual" | "auto"): Mission {
  return createLiveMission({
    holdings,
    totalUsd: 100,
    byChain: { solana: 100, base: 0, bsc: 0 },
    targetPct: 10,
    durationMinutes: 60,
    approval,
    limits: { maxTradeUsd: 25, maxLossPct: 30 },
  });
}

const dir = mkdtempSync(path.join(os.tmpdir(), "dementeking-live-"));
const token = "c".repeat(64);
let walletValue = 100;
const sent: string[] = [];
const signer = createSignerServer({
  dir,
  token,
  deps: {
    walletValueUsd: async () => walletValue,
    sendSolana: async (_a, b64) => (sent.push(b64), { hash: "sig" + sent.length, ok: true }),
    sendEvm: async () => ({ hash: "0xabc", ok: true }),
  },
});
const port = await signer.listen();
const origin = `http://127.0.0.1:${port}`;
after(() => signer.server.close());

const api = async (p: string, body: unknown) => {
  const r = await fetch(origin + p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const page = (p: string, body?: unknown, cookie = "") =>
  fetch(origin + p, { method: body === undefined ? "GET" : "POST", headers: { origin, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("firmante bloqueado: no concede nada", async () => {
  const m = liveMission("auto");
  const r = await api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 5, summary: "x" });
  assert.equal(r.status, 423);
});

let cookie = "";
test("modo autónomo: dentro de los límites da ticket; fuera, no; el ticket de un swap se usa una vez", async () => {
  const created = await page("/wallet/create", { password: "contraseña de prueba" });
  cookie = created.headers.get("set-cookie")!.split(";")[0]!;
  const m = liveMission("auto");
  const over = await api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 40, summary: "demasiado" });
  assert.equal(over.status, 403);
  assert.match(over.body.error, /máximo por operación/);
  const ok = await api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 20, summary: "comprar" });
  assert.equal(ok.status, 200);
  // Otra cadena o más importe que el aprobado: no.
  assert.equal((await api("/api/sign", { ticket: ok.body.ticket, chain: "base", kind: "swap", usd: 20, evmTx: {} })).status, 403);
  assert.equal((await api("/api/sign", { ticket: ok.body.ticket, chain: "solana", kind: "swap", usd: 60, solanaTx: "AA" })).status, 403);
  const signed = await api("/api/sign", { ticket: ok.body.ticket, chain: "solana", kind: "swap", usd: 21, solanaTx: "AA" });
  assert.deepEqual([signed.status, signed.body.ok], [200, true]);
  assert.equal((await api("/api/sign", { ticket: ok.body.ticket, chain: "solana", kind: "swap", usd: 21, solanaTx: "AA" })).status, 403, "ticket ya usado");
  // Por debajo de la pérdida máxima: comprar no, vender sí.
  walletValue = 60;
  assert.equal((await api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 5, summary: "x" })).status, 403);
  assert.equal((await api("/api/intent", { missionId: m.id, chain: "solana", side: "sell", usd: 50, summary: "vender" })).status, 200);
  // Mover capital entre las propias cadenas también se permite (no cambia el riesgo)...
  const move = await api("/api/intent", { missionId: m.id, chain: "solana", side: "move", usd: 50, summary: "puente" });
  assert.equal(move.status, 200);
  walletValue = 100;
  // ...pero un ticket de puente no sirve para un swap, ni uno de compra para un puente.
  assert.equal((await api("/api/sign", { ticket: move.body.ticket, chain: "solana", kind: "swap", usd: 50, solanaTx: "AA" })).status, 403);
  const buy = await api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 10, summary: "comprar" });
  assert.equal((await api("/api/sign", { ticket: buy.body.ticket, chain: "solana", kind: "bridge", usd: 10, solanaTx: "AA" })).status, 403);
  assert.equal((await api("/api/sign", { ticket: move.body.ticket, chain: "solana", kind: "bridge", usd: 50, solanaTx: "AA", budget: { lamports: "1", tokens: {} } })).status, 200);
});

test("modo manual: la operación espera a que el usuario la apruebe o la rechace en su página", async () => {
  const m = liveMission("manual");
  const pendingIntent = api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 10, summary: "Comprar MEME con 10 USDC" });
  let list: any[] = [];
  for (let i = 0; i < 20 && !list.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    list = await (await page("/wallet/pending", undefined, cookie)).json();
  }
  assert.equal(list[0].summary, "Comprar MEME con 10 USDC");
  // Sin la cookie del usuario no se puede aprobar.
  assert.equal((await page("/wallet/decide", { id: list[0].id, approve: true })).status, 401);
  assert.equal((await page("/wallet/decide", { id: list[0].id, approve: true }, cookie)).status, 200);
  const r = await pendingIntent;
  assert.equal(r.status, 200);
  assert.ok(r.body.ticket);

  const rejected = api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 10, summary: "otra" });
  await new Promise((r) => setTimeout(r, 100));
  const [p] = await (await page("/wallet/pending", undefined, cookie)).json();
  await page("/wallet/decide", { id: p.id, approve: false }, cookie);
  assert.equal((await rejected).status, 403);
});

test("parar todo rechaza lo pendiente y bloquea la firma", async () => {
  const m = liveMission("manual");
  const waiting = api("/api/intent", { missionId: m.id, chain: "solana", side: "buy", usd: 10, summary: "x" });
  await new Promise((r) => setTimeout(r, 100));
  await page("/wallet/stop", {}, cookie);
  assert.equal((await waiting).status, 403);
  assert.equal((await api("/api/intent", { missionId: m.id, chain: "solana", side: "sell", usd: 1, summary: "x" })).status, 423);
});

test("las herramientas no mezclan modos: en una misión real no se simula ni se usa Binance", async () => {
  const m = liveMission("auto");
  const ctx = { sessionId: 1, missionId: m.id };
  const sim = await runTool("simulate_swap", { chain: "solana", input: "USDC", output: "SOL", amount: 1, thesis: { why: "x", evidence: "x", sources: ["x"], exit_plan: "x", beliefs_applied: [], memory_note: "x" } }, ctx);
  assert.equal(sim.isError, true);
  assert.match(String(sim.content), /execute_swap/);
  const bin = await runTool("simulate_binance_market_order", { symbol: "SOLUSDT", side: "BUY", amount: 10, thesis: { why: "x", evidence: "x", sources: ["x"], exit_plan: "x", beliefs_applied: [], memory_note: "x" } }, ctx);
  assert.equal(bin.isError, true);
  assert.match(String(bin.content), /REAL/);
  const br = await runTool("simulate_bridge", { from_chain: "solana", to_chain: "base", token_in: "USDC", token_out: "USDC", amount: 5, thesis: { why: "x", evidence: "x", sources: ["x"], exit_plan: "x", beliefs_applied: [], memory_note: "x" } }, ctx);
  assert.match(String(br.content), /execute_bridge/);
});

test("puente real en camino: no se abona por tiempo y no se cuenta dos veces cuando empieza a llegar", async () => {
  const m = liveMission("auto");
  const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  db.prepare("INSERT INTO holdings (mission_id, venue, asset, symbol, decimals, amount) VALUES (?, 'base', ?, 'USDC', 6, 3)").run(m.id, BASE_USDC);
  db.prepare(
    `INSERT INTO transfers (mission_id, session_id, created_at, arrives_at, status, kind, from_venue, to_venue, provider, asset_out, symbol_out, amount_out,
       asset_in, symbol_in, decimals_in, amount_in, value_usd, costs, carry)
     VALUES (?, NULL, ?, ?, 'pending', 'bridge', 'solana', 'base', 'Li.Fi (test)', 'x', 'USDC', 20, ?, 'USDC', 6, 19.9, 19.9, '[]', ?)`,
  ).run(m.id, new Date().toISOString(), new Date(Date.now() - 60_000).toISOString(), BASE_USDC, JSON.stringify({ live: { txHash: "abc", tool: "test", baseline: 3 } }));
  // Ya "debería" haber llegado por tiempo, pero en una misión real solo cuenta lo que confirme Li.Fi.
  await settleTransfers({ missionId: m.id, force: true });
  assert.equal((db.prepare("SELECT status FROM transfers WHERE mission_id = ?").get(m.id) as { status: string }).status, "pending");
  const total = () => valuation(m.id).then((v) => v.totalUsd);
  const before = await total();
  // Llegan los fondos a Base (el espejo de la cadena lo refleja) antes de que Li.Fi lo confirme.
  db.prepare("UPDATE holdings SET amount = 22.9 WHERE mission_id = ? AND venue = 'base' AND asset = ?").run(m.id, BASE_USDC);
  const after = await total();
  assert.ok(Math.abs(after - before) < 0.01, `${before} → ${after}: contado dos veces`);
});
