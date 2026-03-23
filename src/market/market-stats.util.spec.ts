import {
  buildHourlyWindows,
  cautionFromStats,
  computeWindowStats,
  maxHighInCandles,
  parseBinanceKline,
  sliceLastHours,
  windowHighForHours,
} from './market-stats.util';

describe('market-stats.util', () => {
  it('parseBinanceKline', () => {
    const raw = [1_700_000_000_000, '100', '110', '90', '105', '1'];
    const c = parseBinanceKline(raw);
    expect(c).toEqual({
      openTime: 1_700_000_000_000,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
    });
  });

  it('computeWindowStats flat price', () => {
    const candles = [
      { openTime: 1, open: 100, high: 101, low: 99, close: 100 },
      { openTime: 2, open: 100, high: 101, low: 99, close: 100 },
    ];
    const s = computeWindowStats(candles);
    expect(s.changePct).toBeCloseTo(0, 5);
    expect(s.rangePct).toBeCloseTo(2, 5);
    expect(s.returnStdevPp).toBe(0);
  });

  it('sliceLastHours', () => {
    const a = Array.from({ length: 30 }, (_, i) => ({
      openTime: i,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    }));
    expect(sliceLastHours(a, 10).length).toBe(10);
  });

  it('buildHourlyWindows uses last segments', () => {
    const candles = Array.from({ length: 50 }, (_, i) => ({
      openTime: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    }));
    const w = buildHourlyWindows(candles);
    expect(w.h24.hours).toBe(24);
    expect(w.h168.hours).toBe(168);
    expect(w.h720.hours).toBe(720);
  });

  it('maxHighInCandles', () => {
    const candles = [
      { openTime: 1, open: 100, high: 102, low: 99, close: 100 },
      { openTime: 2, open: 100, high: 105, low: 100, close: 101 },
    ];
    expect(maxHighInCandles(candles)).toBe(105);
  });

  it('windowHighForHours maps to h24 / h168 / h720', () => {
    const highs = { h24: 10, h168: 20, h720: 30 };
    expect(windowHighForHours(highs, 12)).toBe(10);
    expect(windowHighForHours(highs, 48)).toBe(20);
    expect(windowHighForHours(highs, 200)).toBe(30);
  });

  it('cautionFromStats elevated on dump + vol', () => {
    const w = {
      h24: {
        hours: 24,
        changePct: -1,
        rangePct: 5,
        returnStdevPp: 0.5,
      },
      h168: {
        hours: 168,
        changePct: -10,
        rangePct: 20,
        returnStdevPp: 0.2,
      },
      h720: {
        hours: 720,
        changePct: -1,
        rangePct: 30,
        returnStdevPp: 0.1,
      },
    };
    const c = cautionFromStats(w);
    expect(c.level).toBe('elevated');
  });
});
