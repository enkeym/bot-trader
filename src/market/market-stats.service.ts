import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinancePublicService } from '../binance/binance-public.service';
import { RedisService } from '../redis/redis.service';
import {
  buildHourlyWindows,
  cautionFromStats,
  maxHighInCandles,
  parseBinanceKline,
  sliceLastHours,
  type WindowStats,
} from './market-stats.util';

/** v2: отчёт включает windowHighs для фильтра входа */
const CACHE_PREFIX = 'market:stats:v2:';

export type MarketStatsReport = {
  symbol: string;
  interval: '1h';
  candlesUsed: number;
  windows: {
    h24: WindowStats;
    h168: WindowStats;
    h720: WindowStats;
  };
  /** Макс. high за 24h / 7d / 30d (по тем же свечам, что windows). */
  windowHighs: { h24: number; h168: number; h720: number };
  caution: ReturnType<typeof cautionFromStats>;
  disclaimer: string;
  fetchedAt: string;
};

@Injectable()
export class MarketStatsService {
  private readonly log = new Logger(MarketStatsService.name);
  private readonly memoryCache = new Map<
    string,
    { at: number; report: MarketStatsReport }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly publicApi: BinancePublicService,
    private readonly redis: RedisService,
  ) {}

  private cacheTtlSec(): number {
    return Math.max(
      30,
      this.config.get<number>('marketStats.cacheTtlSec') ?? 120,
    );
  }

  private spotPublicBaseUrl(): string {
    return (
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com'
    ).replace(/\/$/, '');
  }

  /**
   * Сводка по 1h свечам: окна 24h / 7d / 30d (последние 720 часов ≈ 30 суток).
   * Символ: аргумент /market → MARKET_STATS_SYMBOL → BINANCE_SPOT_SYMBOL → SOLUSDT.
   * На testnet пары вроде USDTRUB часто отсутствуют — задайте MARKET_STATS_SYMBOL=BTCUSDT.
   */
  async getReport(symbol?: string): Promise<MarketStatsReport | null> {
    const fromEnv = this.config.get<string>('marketStats.klinesSymbol') ?? '';
    const preferred =
      (symbol != null && symbol.trim() !== '' ? symbol.trim() : null) ??
      (fromEnv !== '' ? fromEnv : null) ??
      this.config.get<string>('binance.spotSymbol') ??
      'SOLUSDT';
    let sym = preferred.toUpperCase().replace(/\s+/g, '');
    const ttl = this.cacheTtlSec();
    const now = Date.now();

    const tryCache = (s: string): MarketStatsReport | null => {
      const k = `${CACHE_PREFIX}${s}`;
      const mem = this.memoryCache.get(k);
      if (mem && now - mem.at < ttl * 1000) {
        return mem.report;
      }
      return null;
    };
    const tryRedis = async (s: string): Promise<MarketStatsReport | null> => {
      const k = `${CACHE_PREFIX}${s}`;
      const rj = await this.redis.getJson<MarketStatsReport>(k);
      if (rj) {
        this.memoryCache.set(k, { at: now, report: rj });
        return rj;
      }
      return null;
    };

    let cached = tryCache(sym);
    if (cached) return cached;
    const rj0 = await tryRedis(sym);
    if (rj0) return rj0;

    const baseUrl = this.spotPublicBaseUrl();
    let res = await this.publicApi.getKlines({
      symbol: sym,
      interval: '1h',
      limit: 1000,
    });
    let usedFallback = false;
    const invalid =
      !res.ok &&
      (res.code === -1121 ||
        String(res.error ?? '')
          .toLowerCase()
          .includes('invalid symbol'));
    if (invalid) {
      const errFirst = !res.ok ? res.error : '';
      const fb =
        this.config.get<string>('marketStats.fallbackKlinesSymbol') ??
        'BTCUSDT';
      if (fb && fb.toUpperCase() !== sym) {
        this.log.warn(
          `market stats: ${sym} недоступен на ${baseUrl} (${errFirst}) — пробуем ${fb}`,
        );
        sym = fb.toUpperCase().replace(/\s+/g, '');
        usedFallback = true;
        cached = tryCache(sym);
        if (cached) return cached;
        const rjFb = await tryRedis(sym);
        if (rjFb) return rjFb;
        res = await this.publicApi.getKlines({
          symbol: sym,
          interval: '1h',
          limit: 1000,
        });
      } else {
        this.log.warn(
          `market stats: ${sym} @ ${baseUrl}: ${errFirst} (на testnet задайте MARKET_STATS_SYMBOL=BTCUSDT или пару из списка testnet)`,
        );
        return null;
      }
    }
    if (!res.ok) {
      this.log.warn(`market stats: ${sym} @ ${baseUrl}: ${res.error}`);
      return null;
    }

    const cacheKey = `${CACHE_PREFIX}${sym}`;
    cached = tryCache(sym);
    if (cached) return cached;
    const rjFinal = await tryRedis(sym);
    if (rjFinal) return rjFinal;

    const candles = res.data
      .map(parseBinanceKline)
      .filter((c): c is NonNullable<typeof c> => c != null);
    if (candles.length < 24) {
      this.log.warn(`market stats: too few candles for ${sym}`);
      return null;
    }

    const windows = buildHourlyWindows(candles);
    const w24 = sliceLastHours(candles, 24);
    const w168 = sliceLastHours(candles, 168);
    const w720 = sliceLastHours(candles, 720);
    const windowHighs = {
      h24: maxHighInCandles(w24),
      h168: maxHighInCandles(w168),
      h720: maxHighInCandles(w720),
    };
    const caution = cautionFromStats(windows);
    const baseDisclaimer =
      'Справочная аналитика по публичным свечам Binance, не инвестиционная рекомендация.';
    const report: MarketStatsReport = {
      symbol: sym,
      interval: '1h',
      candlesUsed: candles.length,
      windows,
      windowHighs,
      caution,
      disclaimer: usedFallback
        ? `${baseDisclaimer} Показаны свечи ${sym}: запрошенный символ на ${baseUrl} недоступен (часто на testnet нет USDTRUB и др.).`
        : baseDisclaimer,
      fetchedAt: new Date().toISOString(),
    };

    const spotSymConfigured = (
      this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT'
    )
      .toUpperCase()
      .replace(/\s+/g, '');
    if (sym.toUpperCase() !== spotSymConfigured) {
      this.log.warn(
        `market stats: символ свечей ${sym} ≠ BINANCE_SPOT_SYMBOL=${spotSymConfigured} — фильтры roundtrip должны запрашивать свечи той же пары (getReport(symbol) из автоторговли).`,
      );
    }

    await this.redis.setJson(cacheKey, report, ttl);
    this.memoryCache.set(cacheKey, { at: now, report });

    return report;
  }

  formatTelegram(report: MarketStatsReport): string {
    const fmt = (w: WindowStats) => {
      const c = Number.isFinite(w.changePct)
        ? `${w.changePct >= 0 ? '+' : ''}${w.changePct.toFixed(2)}%`
        : '—';
      const r = Number.isFinite(w.rangePct) ? `${w.rangePct.toFixed(2)}%` : '—';
      const v = Number.isFinite(w.returnStdevPp)
        ? `${w.returnStdevPp.toFixed(3)} п.п.`
        : '—';
      return `изм ${c}, диапазон ${r}, σ доходностей ${v}`;
    };
    const w = report.windows;
    const lines = [
      `📈 Рынок Spot (${report.symbol})`,
      `Свечи: 1h, использовано ${report.candlesUsed} (макс. запрос 1000).`,
      '',
      `24h: ${fmt(w.h24)}`,
      `7d: ${fmt(w.h168)}`,
      `30d: ${fmt(w.h720)}`,
      '',
      `Осторожность: ${report.caution.level} — ${report.caution.summary}`,
      '',
      report.disclaimer,
    ];
    return lines.join('\n');
  }
}
