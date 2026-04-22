import { Injectable } from '@nestjs/common';
import type { KlineCandle } from '../market/market-stats.util';

/**
 * Чистые функции технического анализа:
 * EMA, RSI, ATR, ADX, swing low/high.
 * Ни одна функция не делает сетевых вызовов и не зависит от Nest DI.
 */

export function ema(values: number[], period: number): number[] {
  if (!(period > 0) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = new Array<number>(values.length);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function emaLast(values: number[], period: number): number {
  const arr = ema(values, period);
  return arr.length === 0 ? NaN : arr[arr.length - 1];
}

/**
 * RSI (Wilder): возвращает полный массив длиной values.length.
 * Значения до `period` — NaN (недостаточно данных).
 */
export function rsi(values: number[], period = 14): number[] {
  const n = values.length;
  const out: number[] = new Array<number>(n).fill(NaN);
  if (period <= 0 || n <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss <= 0) return avgGain <= 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * ATR (Wilder): возвращает последнее значение или NaN, если данных мало.
 */
export function atrLast(candles: KlineCandle[], period = 14): number {
  if (!(period > 0) || candles.length <= period) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const h = candles[i].high;
    const l = candles[i].low;
    const tr = Math.max(
      h - l,
      Math.abs(h - prevClose),
      Math.abs(l - prevClose),
    );
    trs.push(tr);
  }
  if (trs.length < period) return NaN;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * ADX (Wilder) — возвращает последнее значение или NaN при нехватке данных.
 */
export function adxLast(candles: KlineCandle[], period = 14): number {
  if (!(period > 0) || candles.length <= period + 1) return NaN;
  const n = candles.length;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
    trs.push(tr);
  }
  if (trs.length < period) return NaN;

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 0; i < period; i++) {
    smTr += trs[i];
    smPlus += plusDM[i];
    smMinus += minusDM[i];
  }

  const dxArr: number[] = [];
  const firstDx = computeDx(smPlus, smMinus, smTr);
  if (Number.isFinite(firstDx)) dxArr.push(firstDx);

  for (let i = period; i < trs.length; i++) {
    smTr = smTr - smTr / period + trs[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    const dx = computeDx(smPlus, smMinus, smTr);
    if (Number.isFinite(dx)) dxArr.push(dx);
  }

  if (dxArr.length < period) return NaN;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dxArr[i];
  adx /= period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }
  return adx;
}

function computeDx(smPlus: number, smMinus: number, smTr: number): number {
  if (!(smTr > 0)) return NaN;
  const plusDi = (100 * smPlus) / smTr;
  const minusDi = (100 * smMinus) / smTr;
  const sum = plusDi + minusDi;
  if (!(sum > 0)) return 0;
  return (100 * Math.abs(plusDi - minusDi)) / sum;
}

/** Минимум low за последние `lookback` свечей (исключая текущую). */
export function swingLow(candles: KlineCandle[], lookback: number): number {
  if (candles.length === 0 || lookback <= 0) return NaN;
  const start = Math.max(0, candles.length - 1 - lookback);
  let m = Infinity;
  for (let i = start; i < candles.length - 1; i++) {
    if (candles[i].low < m) m = candles[i].low;
  }
  return Number.isFinite(m) ? m : NaN;
}

/** Максимум high за последние `lookback` свечей (исключая текущую). */
export function swingHigh(candles: KlineCandle[], lookback: number): number {
  if (candles.length === 0 || lookback <= 0) return NaN;
  const start = Math.max(0, candles.length - 1 - lookback);
  let m = -Infinity;
  for (let i = start; i < candles.length - 1; i++) {
    if (candles[i].high > m) m = candles[i].high;
  }
  return Number.isFinite(m) ? m : NaN;
}

@Injectable()
export class TaService {
  ema(values: number[], period: number): number[] {
    return ema(values, period);
  }
  emaLast(values: number[], period: number): number {
    return emaLast(values, period);
  }
  rsi(values: number[], period = 14): number[] {
    return rsi(values, period);
  }
  rsiLast(values: number[], period = 14): number {
    const arr = rsi(values, period);
    return arr.length === 0 ? NaN : arr[arr.length - 1];
  }
  atrLast(candles: KlineCandle[], period = 14): number {
    return atrLast(candles, period);
  }
  adxLast(candles: KlineCandle[], period = 14): number {
    return adxLast(candles, period);
  }
  swingLow(candles: KlineCandle[], lookback: number): number {
    return swingLow(candles, lookback);
  }
  swingHigh(candles: KlineCandle[], lookback: number): number {
    return swingHigh(candles, lookback);
  }
}
