/**
 * Разбор и агрегаты по свечам Binance klines (массивы полей).
 */

export type KlineCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type WindowStats = {
  hours: number;
  /** Изменение close от open первой свечи окна до close последней, % */
  changePct: number;
  /** Диапазон (max high − min low) относительно open первой свечи, % */
  rangePct: number;
  /** Стандартное отклонение почасовых простых доходностей по close, п.п. */
  returnStdevPp: number;
};

export function parseBinanceKline(raw: unknown): KlineCandle | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const o = Number(raw[1]);
  const h = Number(raw[2]);
  const l = Number(raw[3]);
  const c = Number(raw[4]);
  if (![o, h, l, c].every((x) => Number.isFinite(x))) return null;
  return {
    openTime: Number(raw[0]),
    open: o,
    high: h,
    low: l,
    close: c,
  };
}

export function computeWindowStats(
  candles: KlineCandle[],
): Omit<WindowStats, 'hours'> {
  if (candles.length === 0) {
    return {
      changePct: NaN,
      rangePct: NaN,
      returnStdevPp: NaN,
    };
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  const openStart = first.open;
  const closeEnd = last.close;
  const changePct =
    openStart > 0 ? ((closeEnd - openStart) / openStart) * 100 : NaN;

  let highM = -Infinity;
  let lowM = Infinity;
  for (const c of candles) {
    if (c.high > highM) highM = c.high;
    if (c.low < lowM) lowM = c.low;
  }
  const rangePct = openStart > 0 ? ((highM - lowM) / openStart) * 100 : NaN;

  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    if (prev > 0) {
      rets.push(((cur - prev) / prev) * 100);
    }
  }
  if (rets.length === 0) {
    return { changePct, rangePct, returnStdevPp: 0 };
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const returnStdevPp = Math.sqrt(variance);

  return { changePct, rangePct, returnStdevPp };
}

/** Последние `hours` свечей (массив от старых к новым). */
export function sliceLastHours(
  candles: KlineCandle[],
  hours: number,
): KlineCandle[] {
  if (candles.length === 0 || hours <= 0) return [];
  const n = Math.min(hours, candles.length);
  return candles.slice(-n);
}

export function buildHourlyWindows(hourlyCandles: KlineCandle[]): {
  h24: WindowStats;
  h168: WindowStats;
  h720: WindowStats;
} {
  const w24 = sliceLastHours(hourlyCandles, 24);
  const w168 = sliceLastHours(hourlyCandles, 168);
  const w720 = sliceLastHours(hourlyCandles, 720);
  const s24 = computeWindowStats(w24);
  const s168 = computeWindowStats(w168);
  const s720 = computeWindowStats(w720);
  return {
    h24: { hours: 24, ...s24 },
    h168: { hours: 168, ...s168 },
    h720: { hours: 720, ...s720 },
  };
}

export type CautionLevel = 'low' | 'moderate' | 'elevated';

/**
 * Эвристика «осторожность входа» (не инвестиционная рекомендация).
 */
export function cautionFromStats(w: {
  h24: WindowStats;
  h168: WindowStats;
  h720: WindowStats;
}): { level: CautionLevel; summary: string } {
  const v24 = w.h24.returnStdevPp;
  const c7 = w.h168.changePct;
  const c30 = w.h720.changePct;
  const volHigh = Number.isFinite(v24) && v24 > 0.35;
  const dump7 = Number.isFinite(c7) && c7 < -8;
  const dump30 = Number.isFinite(c30) && c30 < -15;

  if ((dump7 || dump30) && volHigh) {
    return {
      level: 'elevated',
      summary:
        'Сильная просадка за 7d/30d при повышенной волатильности за сутки — повышенный риск резких движений.',
    };
  }
  if (dump7 || dump30) {
    return {
      level: 'moderate',
      summary:
        'Заметная отрицательная динамика за неделю или месяц — осторожнее с размером входа.',
    };
  }
  if (volHigh) {
    return {
      level: 'moderate',
      summary:
        'Повышенная внутридневная волатильность — возможны ложные срабатывания узких TP/SL.',
    };
  }
  return {
    level: 'low',
    summary:
      'Без явных красных флагов по этим метрикам; риски рынка всё равно остаются.',
  };
}
