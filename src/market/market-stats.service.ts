import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinancePublicService } from '../binance/binance-public.service';
import { RedisService } from '../redis/redis.service';
import {
  buildHourlyWindows,
  cautionFromStats,
  parseBinanceKline,
  type WindowStats,
} from './market-stats.util';

const CACHE_PREFIX = 'market:stats:';

export type MarketStatsReport = {
  symbol: string;
  interval: '1h';
  candlesUsed: number;
  windows: {
    h24: WindowStats;
    h168: WindowStats;
    h720: WindowStats;
  };
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

  /**
   * Сводка по 1h свечам: окна 24h / 7d / 30d (последние 720 часов ≈ 30 суток).
   */
  async getReport(symbol?: string): Promise<MarketStatsReport | null> {
    const sym = (
      symbol ??
      this.config.get<string>('binance.spotSymbol') ??
      'SOLUSDT'
    )
      .toUpperCase()
      .replace(/\s+/g, '');
    const key = `${CACHE_PREFIX}${sym}`;
    const ttl = this.cacheTtlSec();
    const now = Date.now();

    const mem = this.memoryCache.get(key);
    if (mem && now - mem.at < ttl * 1000) {
      return mem.report;
    }

    const rj = await this.redis.getJson<MarketStatsReport>(key);
    if (rj) {
      this.memoryCache.set(key, { at: now, report: rj });
      return rj;
    }

    const res = await this.publicApi.getKlines({
      symbol: sym,
      interval: '1h',
      limit: 1000,
    });
    if (!res.ok) {
      this.log.warn(`market stats: ${res.error}`);
      return null;
    }

    const candles = res.data
      .map(parseBinanceKline)
      .filter((c): c is NonNullable<typeof c> => c != null);
    if (candles.length < 24) {
      this.log.warn(`market stats: too few candles for ${sym}`);
      return null;
    }

    const windows = buildHourlyWindows(candles);
    const caution = cautionFromStats(windows);
    const report: MarketStatsReport = {
      symbol: sym,
      interval: '1h',
      candlesUsed: candles.length,
      windows,
      caution,
      disclaimer:
        'Справочная аналитика по публичным свечам Binance, не инвестиционная рекомендация.',
      fetchedAt: new Date().toISOString(),
    };

    await this.redis.setJson(key, report, ttl);
    this.memoryCache.set(key, { at: now, report });

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
