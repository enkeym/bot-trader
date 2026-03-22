/** Ответ биржи на MARKET-ордер: база и сумма в валюте котировки (USDT, RUB, …). */
export function parseSpotExchangeFill(ex: unknown): {
  baseQty: number;
  quoteQty: number;
} {
  if (!ex || typeof ex !== 'object') return { baseQty: NaN, quoteQty: NaN };
  const o = ex as Record<string, unknown>;
  const eq = o['executedQty'];
  const baseQty = typeof eq === 'string' ? parseFloat(eq) : Number(eq ?? NaN);
  const cq = o['cummulativeQuoteQty'] ?? o['cumQuote'];
  const quoteQty = typeof cq === 'string' ? parseFloat(cq) : Number(cq ?? NaN);
  return { baseQty, quoteQty };
}

/**
 * Краткий баланс Spot для Telegram: сначала котировка, затем база.
 */
export function formatSpotBalanceShortLines(
  quoteAsset: string,
  baseAsset: string,
  quoteRow: { free: string; locked: string } | undefined,
  baseRow: { free: string; locked: string } | undefined,
): string[] {
  const uf = quoteRow ? parseFloat(quoteRow.free) : 0;
  const ul = quoteRow ? parseFloat(quoteRow.locked) : 0;
  const uTot = uf + ul;
  const bf = baseRow ? parseFloat(baseRow.free) : 0;
  const bl = baseRow ? parseFloat(baseRow.locked) : 0;
  const bTot = bf + bl;

  const fmtU = (n: number) =>
    n.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  const fmtB = (n: number) => {
    const s = n.toFixed(8).replace(/\.?0+$/, '');
    return s === '' ? '0' : s;
  };

  return [
    `${quoteAsset}: ${fmtU(uTot)} (свободно ${fmtU(uf)}${ul > 0 ? `, в ордерах ${fmtU(ul)}` : ''})`,
    `${baseAsset}: ${fmtB(bTot)} (свободно ${fmtB(bf)}${bl > 0 ? `, в ордерах ${fmtB(bl)}` : ''})`,
  ];
}
