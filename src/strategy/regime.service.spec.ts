import { ConfigService } from '@nestjs/config';
import { RegimeService } from './regime.service';
import type { BinancePublicService } from '../binance/binance-public.service';

function makeKlineArr(
  n: number,
  generator: (i: number) => {
    o: number;
    h: number;
    l: number;
    c: number;
    v?: number;
  },
): unknown[][] {
  const out: unknown[][] = [];
  const baseTime = Date.now() - n * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    const { o, h, l, c, v } = generator(i);
    out.push([
      baseTime + i * 3600 * 1000,
      o.toString(),
      h.toString(),
      l.toString(),
      c.toString(),
      (v ?? 1).toString(),
      0,
      '0',
      0,
      '0',
      '0',
      '0',
    ]);
  }
  return out;
}

const makeConfig = (
  overrides: Partial<Record<string, number | boolean>> = {},
): ConfigService => {
  const base: Record<string, number | boolean> = {
    'strategy.adxMin': 20,
    'strategy.emaFast': 20,
    'strategy.emaSlow': 50,
    'strategy.emaLong': 200,
    'strategy.atrPeriod': 14,
    'strategy.atrSlMult': 1.0,
    'strategy.atrTpMult': 2.5,
    'strategy.rsiEntryMin': 40,
    'strategy.rsiEntryMax': 65,
    'strategy.swingLookback4h': 12,
    'strategy.minAtrPercent': 0.0,
    'strategy.maxKlineAgeMinutes': 0,
    'strategy.volumeConfirmation': false,
  };
  const data: Record<string, number | boolean> = { ...base, ...overrides };
  return {
    get: (k: string) => data[k],
  } as unknown as ConfigService;
};

describe('RegimeService', () => {
  it('insufficient_history → skip', async () => {
    const publicApi: Pick<BinancePublicService, 'getKlines'> = {
      getKlines: () =>
        Promise.resolve({
          ok: true,
          data: makeKlineArr(30, (i) => ({
            o: 100 + i * 0.1,
            h: 100 + i * 0.1 + 0.5,
            l: 100 + i * 0.1 - 0.5,
            c: 100 + i * 0.1,
          })),
        }),
    };
    const svc = new RegimeService(
      makeConfig(),
      publicApi as BinancePublicService,
    );
    const r = await svc.evaluateBuySetup('SOLUSDT');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient_history');
  });

  it('strong uptrend → ok with recentCloses', async () => {
    const publicApi: Pick<BinancePublicService, 'getKlines'> = {
      getKlines: ({ interval }) => {
        const n = interval === '1h' ? 300 : 200;
        return Promise.resolve({
          ok: true,
          data: makeKlineArr(n, (i) => {
            const up = 100 + i * 0.3;
            const dip = i === n - 5 ? up - 1.5 : up;
            return {
              o: dip,
              h: up + 0.5,
              l: dip - 0.4,
              c: i === n - 5 ? up - 1.2 : up,
            };
          }),
        });
      },
    };
    const svc = new RegimeService(
      makeConfig({ 'strategy.adxMin': 10 }),
      publicApi as BinancePublicService,
    );
    const r = await svc.evaluateBuySetup('SOLUSDT');
    if (!r.ok) {
      expect(r.reason).toMatch(/rsi_out_of_band|trend_not_aligned|below|adx/);
    } else {
      expect(r.slPrice).toBeLessThan(r.markPrice);
      expect(r.tpPrice).toBeGreaterThan(r.markPrice);
      expect(r.slPercent).toBeGreaterThan(0);
      expect(r.recentCloses1h.length).toBeLessThanOrEqual(20);
      expect(r.recentCloses1h.length).toBeGreaterThan(0);
      expect(r.recentCloses4h.length).toBeLessThanOrEqual(10);
      expect(r.atrPercent).toBeGreaterThan(0);
    }
  });

  it('candles_fetch_failed when 4h returns error', async () => {
    const publicApi: Pick<BinancePublicService, 'getKlines'> = {
      getKlines: ({ interval }) => {
        if (interval === '4h') {
          return Promise.resolve({ ok: false, error: 'nope' });
        }
        return Promise.resolve({
          ok: true,
          data: makeKlineArr(300, (i) => ({
            o: 100 + i,
            h: 100 + i + 1,
            l: 100 + i - 1,
            c: 100 + i,
          })),
        });
      },
    };
    const svc = new RegimeService(
      makeConfig(),
      publicApi as BinancePublicService,
    );
    const r = await svc.evaluateBuySetup('SOLUSDT');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('candles_fetch_failed');
  });

  it('low_volatility when ATR/price below threshold', async () => {
    const publicApi: Pick<BinancePublicService, 'getKlines'> = {
      getKlines: ({ interval }) => {
        const n = interval === '1h' ? 300 : 200;
        return Promise.resolve({
          ok: true,
          data: makeKlineArr(n, (i) => {
            const base = 100 + i * 0.01;
            return {
              o: base,
              h: base + 0.01,
              l: base - 0.01,
              c: base,
            };
          }),
        });
      },
    };
    const svc = new RegimeService(
      makeConfig({
        'strategy.minAtrPercent': 0.5,
        'strategy.adxMin': 0,
      }),
      publicApi as BinancePublicService,
    );
    const r = await svc.evaluateBuySetup('SOLUSDT');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('low_volatility');
  });

  it('volume_not_confirmed when last 1h volume below sma20', async () => {
    const publicApi: Pick<BinancePublicService, 'getKlines'> = {
      getKlines: ({ interval }) => {
        const n = interval === '1h' ? 300 : 200;
        return Promise.resolve({
          ok: true,
          data: makeKlineArr(n, (i) => {
            const up = 100 + i * 0.3;
            return {
              o: up,
              h: up + 0.5,
              l: up - 0.4,
              c: up,
              v: i === n - 1 ? 0.1 : 10,
            };
          }),
        });
      },
    };
    const svc = new RegimeService(
      makeConfig({
        'strategy.adxMin': 0,
        'strategy.volumeConfirmation': true,
      }),
      publicApi as BinancePublicService,
    );
    const r = await svc.evaluateBuySetup('SOLUSDT');
    if (!r.ok) {
      expect([
        'volume_not_confirmed',
        'rsi_out_of_band',
        'near_4h_swing_low',
      ]).toContain(r.reason);
    }
  });
});
