// Estadística pequeña compartida (sin dependencias): la usan la evidencia de las creencias (memory.ts) y el
// seguimiento por clase de misión (class-stats.ts).

/**
 * Intervalo de Wilson al 95 % de un porcentaje de acierto: con pocos casos es ancho y no deja concluir
 * nada. Con 3 de 3 va del 44 % al 100 %; con 17 de 18, del 74 % al 99 %; con 0 de 20, del 0 al 16 %.
 */
export function wilson(successes: number, n: number): { low: number; high: number } {
  if (!n) return { low: 0, high: 100 };
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.round(Math.max(0, center - half) * 100), high: Math.round(Math.min(1, center + half) * 100) };
}
