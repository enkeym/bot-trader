import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinancePublicService } from '../binance/binance-public.service';
import {
  parseBinanceKline,
  type KlineCandle,
} from '../market/market-stats.util';
import { adxLast, atrLast, emaLast, rsi, swingLow } from './ta.service';

export type RegimeSkipReason =
  | 'insufficient_history'
  | 'candles_fetch_failed'
  | 'adx_low'
  | 'trend_not_aligned_1h_4h'
  | 'below_ema_slow'
  | 'rsi_out_of_band'
  | 'near_4h_swing_low'
  | 'atr_invalid'
  | 'low_volatility'
  | 'stale_klines'
  | 'volume_not_confirmed';

export interface RegimeSkip {
  ok: false;
  reason: RegimeSkipReason;
  diagnostics: Record<string, number | string>;
}

export interface RegimeBuySetup {
  ok: true;
  markPrice: number;
  atr: number;
  /** Относительная волатильность ATR/цена × 100 (для AI/диагностики). */
  atrPercent: number;
  ema20: number;
  ema50: number;
  ema200: number;
  ema50_4h: number;
  rsi14: number;
  adx14: number;
  swingLow4h: number;
  slPrice: number;
  tpPrice: number;
  /** Относительное расстояние SL в процентах (для сайзинга по риску). */
  slPercent: number;
  /** Расстояние TP в % (для effectiveTP с учётом комиссий). */
  tpPercent: number;
  /** Последние 20 close 1h — реальный контекст для AI. */
  recentCloses1h: number[];
  /** Последние 10 close 4h. */
  recentCloses4h: number[];
  /** UTC ms — openTime последней 1h свечи (для проверки свежести в логах). */
  lastCandleOpenTime: number;
  diagnostics: Record<string, number>;
}

export type RegimeResult = RegimeBuySetup | RegimeSkip;

/**
 * Режим-фильтр: ATR-нормализованная стратегия тренд-фолловинг на 1h с подтверждением 4h.
 * Вход только когда:
 *   - ADX(1h, 14) >= ADX_MIN (тренд есть, не боковик);
 *   - 1h цена > EMA_SLOW (обычно 50) и 4h цена > EMA_SLOW_4H;
 *   - RSI(14, 1h) в диапазоне входа (обычно 40..65) — после отката, не в перекупленности;
 *   - mark > 4h swing low (не входим в падающий нож);
 *   - ATR/цена ≥ MIN_ATR_PERCENT (не торгуем на «полке»);
 *   - последняя 1h свеча не старше MAX_KLINE_AGE_MINUTES;
 *   - (опц.) volume(1h)[last] > SMA(volume, 20).
 * SL = mark − ATR_SL_MULT × ATR14, TP = mark + ATR_TP_MULT × ATR14.
 */
@Injectable()
export class RegimeService {
  private readonly log = new Logger(RegimeService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly publicApi: BinancePublicService,
  ) {}

  private cfgNum(key: string, fallback: number): number {
    const v = this.config.get<number>(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  private cfgBool(key: string, fallback: boolean): boolean {
    const v = this.config.get<boolean>(key);
    return typeof v === 'boolean' ? v : fallback;
  }

  async evaluateBuySetup(symbol: string): Promise<RegimeResult> {
    const adxMin = this.cfgNum('strategy.adxMin', 22);
    const emaFast = this.cfgNum('strategy.emaFast', 20);
    const emaSlow = this.cfgNum('strategy.emaSlow', 50);
    const emaLong = this.cfgNum('strategy.emaLong', 200);
    const atrPeriod = this.cfgNum('strategy.atrPeriod', 14);
    const atrSlMult = this.cfgNum('strategy.atrSlMult', 1.0);
    const atrTpMult = this.cfgNum('strategy.atrTpMult', 2.5);
    const rsiMin = this.cfgNum('strategy.rsiEntryMin', 40);
    const rsiMax = this.cfgNum('strategy.rsiEntryMax', 65);
    const swingLookback4h = this.cfgNum('strategy.swingLookback4h', 12);
    const minAtrPct = this.cfgNum('strategy.minAtrPercent', 0.4);
    const maxKlineAgeMin = this.cfgNum('strategy.maxKlineAgeMinutes', 120);
    const volumeConfirm = this.cfgBool('strategy.volumeConfirmation', true);

    const [c1h, c4h] = await Promise.all([
      this.fetchCandles(symbol, '1h', 300),
      this.fetchCandles(symbol, '4h', 200),
    ]);

    if (!c1h.ok) {
      return {
        ok: false,
        reason: 'candles_fetch_failed',
        diagnostics: { interval: '1h', error: c1h.error },
      };
    }
    if (!c4h.ok) {
      return {
        ok: false,
        reason: 'candles_fetch_failed',
        diagnostics: { interval: '4h', error: c4h.error },
      };
    }

    const needed = Math.max(emaLong, atrPeriod * 2, 50);
    if (c1h.candles.length < needed || c4h.candles.length < 50) {
      return {
        ok: false,
        reason: 'insufficient_history',
        diagnostics: {
          candles1h: c1h.candles.length,
          candles4h: c4h.candles.length,
          needed,
        },
      };
    }

    const closes1h = c1h.candles.map((c) => c.close);
    const ema20 = emaLast(closes1h, emaFast);
    const ema50 = emaLast(closes1h, emaSlow);
    const ema200 = emaLast(closes1h, emaLong);
    const rsiArr = rsi(closes1h, 14);
    const rsi14 = rsiArr[rsiArr.length - 1];
    const adx14 = adxLast(c1h.candles, 14);
    const atr = atrLast(c1h.candles, atrPeriod);

    const closes4h = c4h.candles.map((c) => c.close);
    const ema50_4h = emaLast(closes4h, emaSlow);
    const swingLow4h = swingLow(c4h.candles, swingLookback4h);

    const mark = closes1h[closes1h.length - 1];
    const last1h = c1h.candles[c1h.candles.length - 1];
    const lastCandleOpenTime = last1h?.openTime ?? 0;

    const atrPercent =
      mark > 0 && Number.isFinite(atr) ? (atr / mark) * 100 : NaN;

    const diagnostics: Record<string, number> = {
      mark,
      ema20,
      ema50,
      ema200,
      ema50_4h,
      rsi14,
      adx14,
      atr,
      atrPercent: Number.isFinite(atrPercent) ? atrPercent : 0,
      swingLow4h,
      lastCandleOpenTime,
    };

    if (!(atr > 0)) {
      return { ok: false, reason: 'atr_invalid', diagnostics };
    }

    if (maxKlineAgeMin > 0 && lastCandleOpenTime > 0) {
      const ageMin = (Date.now() - lastCandleOpenTime) / 60_000;
      diagnostics.candleAgeMinutes = Number.isFinite(ageMin) ? ageMin : -1;
      if (ageMin > maxKlineAgeMin + 60) {
        return { ok: false, reason: 'stale_klines', diagnostics };
      }
    }

    if (Number.isFinite(atrPercent) && atrPercent < minAtrPct) {
      diagnostics.minAtrPercent = minAtrPct;
      return { ok: false, reason: 'low_volatility', diagnostics };
    }
    if (!(adx14 >= adxMin)) {
      return { ok: false, reason: 'adx_low', diagnostics };
    }
    if (!(mark > ema50) || !(closes4h[closes4h.length - 1] > ema50_4h)) {
      return { ok: false, reason: 'trend_not_aligned_1h_4h', diagnostics };
    }
    if (!(mark > ema200)) {
      return { ok: false, reason: 'below_ema_slow', diagnostics };
    }
    if (!(rsi14 >= rsiMin && rsi14 <= rsiMax)) {
      return { ok: false, reason: 'rsi_out_of_band', diagnostics };
    }
    if (Number.isFinite(swingLow4h) && mark <= swingLow4h) {
      return { ok: false, reason: 'near_4h_swing_low', diagnostics };
    }

    if (volumeConfirm) {
      const last20 = c1h.candles.slice(-21, -1);
      const vols = last20
        .map((c) => c.volume ?? 0)
        .filter((v) => Number.isFinite(v) && v >= 0);
      if (vols.length >= 5) {
        const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
        const lastVol = last1h.volume ?? 0;
        diagnostics.lastVol = lastVol;
        diagnostics.avgVol20 = avgVol;
        if (avgVol > 0 && lastVol < avgVol) {
          return { ok: false, reason: 'volume_not_confirmed', diagnostics };
        }
      }
    }

    const slPrice = mark - atrSlMult * atr;
    const tpPrice = mark + atrTpMult * atr;
    const slPercent = ((mark - slPrice) / mark) * 100;
    const tpPercent = ((tpPrice - mark) / mark) * 100;

    return {
      ok: true,
      markPrice: mark,
      atr,
      atrPercent: Number.isFinite(atrPercent) ? atrPercent : 0,
      ema20,
      ema50,
      ema200,
      ema50_4h,
      rsi14,
      adx14,
      swingLow4h,
      slPrice,
      tpPrice,
      slPercent,
      tpPercent,
      recentCloses1h: closes1h.slice(-20),
      recentCloses4h: closes4h.slice(-10),
      lastCandleOpenTime,
      diagnostics,
    };
  }

  private async fetchCandles(
    symbol: string,
    interval: '1h' | '4h',
    limit: number,
  ): Promise<
    { ok: true; candles: KlineCandle[] } | { ok: false; error: string }
  > {
    const res = await this.publicApi.getKlines({ symbol, interval, limit });
    if (!res.ok) {
      this.log.warn(`regime klines ${symbol} ${interval}: ${res.error}`);
      return { ok: false, error: res.error };
    }
    const candles = res.data
      .map(parseBinanceKline)
      .filter((c): c is KlineCandle => c != null);
    return { ok: true, candles };
  }
}
