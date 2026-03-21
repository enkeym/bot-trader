import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type BinanceKlineInterval =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '8h'
  | '12h'
  | '1d'
  | '3d'
  | '1w'
  | '1M';

/**
 * Публичные REST Spot (без API key): свечи для аналитики рынка.
 */
@Injectable()
export class BinancePublicService {
  private readonly log = new Logger(BinancePublicService.name);

  constructor(private readonly config: ConfigService) {}

  private getBaseUrl(): string {
    return (
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com'
    );
  }

  /**
   * GET /api/v3/klines — до 1000 свечей за запрос.
   */
  async getKlines(params: {
    symbol: string;
    interval: BinanceKlineInterval;
    limit: number;
  }): Promise<
    | { ok: true; data: unknown[][] }
    | { ok: false; error: string; code?: number }
  > {
    const base = this.getBaseUrl().replace(/\/$/, '');
    const symbol = params.symbol.toUpperCase();
    const limit = Math.min(1000, Math.max(1, params.limit));
    try {
      const res = await axios.get(`${base}/api/v3/klines`, {
        params: {
          symbol,
          interval: params.interval,
          limit,
        },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300 && Array.isArray(res.data)) {
        return { ok: true, data: res.data as unknown[][] };
      }
      const err = res.data as { code?: number; msg?: string };
      const msg = err?.msg ?? `HTTP ${res.status}`;
      return { ok: false, error: msg, code: err?.code };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.log.warn(`klines ${symbol}: ${m}`);
      return { ok: false, error: m };
    }
  }
}
