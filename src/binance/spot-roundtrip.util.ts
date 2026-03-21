/**
 * Чистые функции для режима roundtrip Spot (учёт позиции, округление лота).
 */

export type LotSizeFilter = {
  minQty: number;
  stepSize: number;
};

/** Округление вниз к кратности stepSize (Binance LOT_SIZE). */
export function floorToLotSize(qty: number, stepSize: number): number {
  if (stepSize <= 0 || !Number.isFinite(qty) || qty <= 0) return 0;
  const steps = Math.floor(qty / stepSize);
  return steps * stepSize;
}

/**
 * Объём для MARKET SELL: не больше free и tracked, не ниже minQty после округления.
 */
export function computeSellQuantity(params: {
  freeBtc: number;
  trackedBtc: number;
  lot: LotSizeFilter;
}): { quantity: number; skipReason?: string } {
  const cap = Math.min(params.freeBtc, params.trackedBtc);
  if (cap < params.lot.minQty) {
    return {
      quantity: 0,
      skipReason: `объём min(free, tracked)=${cap} < minQty=${params.lot.minQty}`,
    };
  }
  const q = floorToLotSize(cap, params.lot.stepSize);
  if (q < params.lot.minQty) {
    return {
      quantity: 0,
      skipReason: `после округления к stepSize=${params.lot.stepSize} получилось ${q} < minQty`,
    };
  }
  return { quantity: q };
}

export function priceHitsTakeProfit(params: {
  markPrice: number;
  avgEntryUsdt: number;
  takeProfitPercent: number;
}): boolean {
  const { markPrice, avgEntryUsdt, takeProfitPercent } = params;
  if (!(avgEntryUsdt > 0) || !(markPrice > 0)) return false;
  const threshold = avgEntryUsdt * (1 + takeProfitPercent / 100);
  return markPrice >= threshold;
}

/** Стоп-лосс: цена ниже средней на stopLossPercent % (stopLossPercent > 0). */
export function priceHitsStopLoss(params: {
  markPrice: number;
  avgEntryUsdt: number;
  stopLossPercent: number;
}): boolean {
  const { markPrice, avgEntryUsdt, stopLossPercent } = params;
  if (!(stopLossPercent > 0) || !(avgEntryUsdt > 0) || !(markPrice > 0)) {
    return false;
  }
  const threshold = avgEntryUsdt * (1 - stopLossPercent / 100);
  return markPrice <= threshold;
}

/** После BUY: новая средняя и tracked BTC. */
export function applyBuyFill(params: {
  trackedBtc: number;
  avgEntryUsdt: number;
  executedBtc: number;
  quoteUsdtSpent: number;
}): { trackedBtc: number; avgEntryUsdt: number } {
  const { executedBtc, quoteUsdtSpent } = params;
  if (!(executedBtc > 0) || !(quoteUsdtSpent > 0)) {
    return { trackedBtc: params.trackedBtc, avgEntryUsdt: params.avgEntryUsdt };
  }
  const oldT = params.trackedBtc;
  const oldAvg = params.avgEntryUsdt;
  const newT = oldT + executedBtc;
  if (newT <= 0) {
    return { trackedBtc: 0, avgEntryUsdt: 0 };
  }
  const newAvg =
    oldT <= 0
      ? quoteUsdtSpent / executedBtc
      : (oldAvg * oldT + quoteUsdtSpent) / newT;
  return { trackedBtc: newT, avgEntryUsdt: newAvg };
}

/** После SELL: уменьшение tracked; средняя не меняется при частичной продаже. */
export function applySellFill(params: {
  trackedBtc: number;
  avgEntryUsdt: number;
  soldBtc: number;
}): { trackedBtc: number; avgEntryUsdt: number } {
  const sold = Math.min(params.soldBtc, params.trackedBtc);
  const newT = params.trackedBtc - sold;
  if (newT <= 1e-12) {
    return { trackedBtc: 0, avgEntryUsdt: 0 };
  }
  return { trackedBtc: newT, avgEntryUsdt: params.avgEntryUsdt };
}
