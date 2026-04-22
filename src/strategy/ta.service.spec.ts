import {
  adxLast,
  atrLast,
  ema,
  emaLast,
  rsi,
  swingHigh,
  swingLow,
} from './ta.service';
import type { KlineCandle } from '../market/market-stats.util';

const flatCandle = (i: number, price: number): KlineCandle => ({
  openTime: i,
  open: price,
  high: price,
  low: price,
  close: price,
});

const trendCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
): KlineCandle => ({ openTime: i, open, high, low, close });

describe('ta.service', () => {
  it('ema: flat input returns same value', () => {
    const vals = new Array<number>(50).fill(100);
    expect(emaLast(vals, 20)).toBeCloseTo(100, 6);
  });

  it('ema: responds to increasing series', () => {
    const vals = Array.from({ length: 30 }, (_, i) => i + 1);
    const out = ema(vals, 5);
    expect(out.length).toBe(30);
    expect(out[out.length - 1]).toBeGreaterThan(out[0]);
    expect(out[out.length - 1]).toBeLessThan(vals[vals.length - 1]);
  });

  it('rsi: monotonic up series → RSI near 100', () => {
    const vals = Array.from({ length: 30 }, (_, i) => 100 + i);
    const arr = rsi(vals, 14);
    expect(arr[arr.length - 1]).toBeCloseTo(100, 1);
  });

  it('rsi: monotonic down series → RSI near 0', () => {
    const vals = Array.from({ length: 30 }, (_, i) => 100 - i);
    const arr = rsi(vals, 14);
    expect(arr[arr.length - 1]).toBeLessThan(5);
  });

  it('rsi: flat series → 50', () => {
    const vals = new Array<number>(30).fill(100);
    const arr = rsi(vals, 14);
    expect(arr[arr.length - 1]).toBeCloseTo(50, 5);
  });

  it('atrLast: constant candles → 0', () => {
    const candles = Array.from({ length: 30 }, (_, i) => flatCandle(i, 100));
    expect(atrLast(candles, 14)).toBeCloseTo(0, 6);
  });

  it('atrLast: +1/-1 oscillation → atr = 2', () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      trendCandle(i, 100, 101, 99, i % 2 === 0 ? 101 : 99),
    );
    const a = atrLast(candles, 14);
    expect(a).toBeGreaterThan(1.5);
    expect(a).toBeLessThan(3);
  });

  it('atrLast: insufficient history → NaN', () => {
    const candles = Array.from({ length: 5 }, (_, i) => flatCandle(i, 100));
    expect(Number.isNaN(atrLast(candles, 14))).toBe(true);
  });

  it('adxLast: strong uptrend → ADX > 25', () => {
    const candles: KlineCandle[] = [];
    for (let i = 0; i < 80; i++) {
      const p = 100 + i;
      candles.push(trendCandle(i, p - 1, p + 1, p - 1, p));
    }
    const a = adxLast(candles, 14);
    expect(a).toBeGreaterThan(25);
  });

  it('adxLast: flat → ADX small or NaN', () => {
    const candles = Array.from({ length: 80 }, (_, i) => flatCandle(i, 100));
    const a = adxLast(candles, 14);
    if (Number.isFinite(a)) {
      expect(a).toBeLessThan(20);
    }
  });

  it('swingLow/High: exclude current candle', () => {
    const candles = [
      trendCandle(0, 100, 102, 98, 101),
      trendCandle(1, 101, 103, 97, 102),
      trendCandle(2, 102, 104, 95, 103),
    ];
    expect(swingLow(candles, 5)).toBe(97);
    expect(swingHigh(candles, 5)).toBe(103);
  });
});
