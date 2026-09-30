import dotenv from "dotenv";
import path from "node:path";
import { projectRoot, resolveDataDir } from "./paths.js";

// quiet: el servidor MCP usa stdout para el protocolo; dotenv no debe escribir en él.
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} no es un número válido: ${raw}`);
  return value;
}

export const config = {
  model: process.env.MODEL || "claude-opus-5",
  effort: (process.env.EFFORT || "high") as "low" | "medium" | "high" | "xhigh" | "max",
  initialUsd: num("INITIAL_USD", 1000),
  solanaTxFeeSol: num("SOLANA_TX_FEE_SOL", 0.0001),
  binanceTakerFee: num("BINANCE_TAKER_FEE", 0.001),
  // Comisión real de Binance por retirar USDC por la red Solana (septiembre de 2026).
  binanceUsdcWithdrawFee: num("BINANCE_USDC_WITHDRAW_FEE", 0.3),
  maxStepsPerSession: num("MAX_STEPS_PER_SESSION", 80),
  loopPauseMinutes: num("LOOP_PAUSE_MINUTES", 30),
  watchIntervalSeconds: num("WATCH_INTERVAL_SECONDS", 60),
  // Con una misión rápida en marcha (15 min o menos), órdenes, futuros y misión se miran así de a menudo.
  fastWatchIntervalSeconds: num("FAST_WATCH_INTERVAL_SECONDS", 5),
  browserHeadful: process.env.BROWSER_HEADFUL === "true",
  // DATA_DIR permite usar otra base de datos (p. ej. para pruebas) sin tocar la simulación principal.
  dataDir: resolveDataDir(),
};
