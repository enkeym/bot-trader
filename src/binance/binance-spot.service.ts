import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { createHmac } from 'crypto';

function signQuery(secret: string, queryWithoutSig: string): string {
  return createHmac('sha256', secret).update(queryWithoutSig).digest('hex');
}

/** Параметры для подписи: ключи в алфавитном порядке, как ожидает Binance Spot API. */
function buildSignedQueryString(
  params: Record<string, string | number>,
  secret: string,
): string {
  const keys = Object.keys(params).sort();
  const queryWithoutSig = keys.map((k) => `${k}=${params[k]}`).join('&');
  const signature = signQuery(secret, queryWithoutSig);
  return `${queryWithoutSig}&signature=${signature}`;
}

function isRecvWindowOrTimeError(
  data: {
    code?: number;
    msg?: string;
  } | null,
): boolean {
  if (!data) return false;
  if (data.code === -1021) return true;
  const m = data.msg ?? '';
  return m.includes('recvWindow') || m.includes('Timestamp for this request');
}

export type SpotMarketOrderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: number };

@Injectable()
export class BinanceSpotService {
  private readonly log = new Logger(BinanceSpotService.name);

  /** Смещение serverTime − Date.now() из GET /api/v3/time (важно для WSL/несинхронных часов). */
  private serverTimeOffsetMs = 0;

  private lastServerSyncAt = 0;

  private syncPromise: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  private getBaseUrl(): string {
    return (
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com'
    );
  }

  private getCredentials(): { key: string; secret: string } | null {
    const key = this.config.get<string>('binance.apiKey');
    const secret = this.config.get<string>('binance.apiSecret');
    if (!key?.trim() || !secret?.trim()) return null;
    return { key: key.trim(), secret: secret.trim() };
  }

  /** Есть ли ключи для подписанных запросов Spot. */
  spotExecutionAllowed(): boolean {
    return this.getCredentials() != null;
  }

  private recvWindow(): number {
    return this.config.get<number>('binance.recvWindowMs') ?? 60_000;
  }

  /** Timestamp для подписи: по часам Binance, не только по локальным. */
  private signedTimestamp(): number {
    return Date.now() + this.serverTimeOffsetMs;
  }

  /** Синхронизация с GET /api/v3/time; кэш ~1 мин, при ошибке -1021 — принудительно. */
  private async ensureServerTime(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      now - this.lastServerSyncAt < 60_000 &&
      this.lastServerSyncAt > 0
    ) {
      return;
    }
    if (this.syncPromise) {
      await this.syncPromise;
      return;
    }
    this.syncPromise = (async () => {
      const base = this.getBaseUrl().replace(/\/$/, '');
      try {
        const res = await axios.get(`${base}/api/v3/time`, {
          timeout: 10_000,
          validateStatus: () => true,
        });
        if (res.status >= 200 && res.status < 300) {
          const serverTime = (res.data as { serverTime?: number }).serverTime;
          if (typeof serverTime === 'number') {
            this.serverTimeOffsetMs = serverTime - Date.now();
            this.lastServerSyncAt = Date.now();
            return;
          }
        }
        this.log.warn(`GET /api/v3/time неожиданный ответ: HTTP ${res.status}`);
      } catch (e) {
        this.log.warn(
          `GET /api/v3/time: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  /**
   * Рыночный ордер Spot.
   * BUY — через quoteOrderQty (USDT для пары *USDT).
   * SELL — через quantity (базовый актив).
   */
  async placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quoteOrderQty?: number;
    quantity?: number;
  }): Promise<SpotMarketOrderResult> {
    const cred = this.getCredentials();
    if (!cred) {
      return { ok: false, error: 'Нет BINANCE_API_KEY / BINANCE_API_SECRET' };
    }

    if (params.side === 'BUY') {
      if (params.quoteOrderQty == null || params.quoteOrderQty <= 0) {
        return { ok: false, error: 'BUY требует quoteOrderQty > 0' };
      }
    } else {
      if (params.quantity == null || params.quantity <= 0) {
        return { ok: false, error: 'SELL требует quantity > 0' };
      }
    }

    await this.ensureServerTime();
    const timestamp = this.signedTimestamp();
    const baseParams: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: 'MARKET',
      timestamp,
      recvWindow: this.recvWindow(),
    };

    if (params.side === 'BUY') {
      baseParams.quoteOrderQty = Number(
        (params.quoteOrderQty as number).toFixed(8),
      );
    } else {
      baseParams.quantity = Number((params.quantity as number).toFixed(8));
    }

    const doPost = async () => {
      const queryString = buildSignedQueryString(baseParams, cred.secret);
      const url = `${this.getBaseUrl().replace(/\/$/, '')}/api/v3/order`;
      return axios.post(`${url}?${queryString}`, null, {
        headers: { 'X-MBX-APIKEY': cred.key },
        timeout: 30_000,
        validateStatus: () => true,
      });
    };

    try {
      let res = await doPost();
      if (
        res.status >= 400 &&
        isRecvWindowOrTimeError(res.data as { code?: number; msg?: string })
      ) {
        this.lastServerSyncAt = 0;
        await this.ensureServerTime(true);
        baseParams.timestamp = this.signedTimestamp();
        res = await doPost();
      }
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, data: res.data as Record<string, unknown> };
      }
      const data = res.data as { code?: number; msg?: string };
      return {
        ok: false,
        error: data?.msg ?? `HTTP ${res.status}`,
        code: data?.code,
      };
    } catch (e) {
      const err = e as AxiosError<{ code?: number; msg?: string }>;
      const data = err.response?.data;
      return {
        ok: false,
        error: data?.msg ?? err.message ?? 'Unknown error',
        code: data?.code,
      };
    }
  }

  /** Балансы Spot-аккаунта (GET /api/v3/account). */
  async getAccountBalances(): Promise<
    | {
        ok: true;
        balances: Array<{ asset: string; free: string; locked: string }>;
      }
    | { ok: false; error: string }
  > {
    const cred = this.getCredentials();
    if (!cred) {
      return { ok: false, error: 'Нет BINANCE_API_KEY / BINANCE_API_SECRET' };
    }

    const base = this.getBaseUrl().replace(/\/$/, '');
    const params: Record<string, string | number> = {
      recvWindow: this.recvWindow(),
      timestamp: this.signedTimestamp(),
    };

    const fetchOnce = async () => {
      await this.ensureServerTime();
      params.timestamp = this.signedTimestamp();
      const queryString = buildSignedQueryString(params, cred.secret);
      return axios.get(`${base}/api/v3/account?${queryString}`, {
        headers: { 'X-MBX-APIKEY': cred.key },
        timeout: 30_000,
        validateStatus: () => true,
      });
    };

    try {
      let res = await fetchOnce();
      if (
        res.status >= 400 &&
        isRecvWindowOrTimeError(res.data as { code?: number; msg?: string })
      ) {
        this.lastServerSyncAt = 0;
        await this.ensureServerTime(true);
        res = await fetchOnce();
      }
      if (res.status >= 200 && res.status < 300) {
        const data = res.data as {
          balances?: Array<{ asset: string; free: string; locked: string }>;
        };
        return { ok: true, balances: data.balances ?? [] };
      }
      const err = res.data as { msg?: string };
      return { ok: false, error: err?.msg ?? `HTTP ${res.status}` };
    } catch (e) {
      const err = e as AxiosError<{ msg?: string }>;
      return {
        ok: false,
        error: err.response?.data?.msg ?? err.message ?? 'Unknown error',
      };
    }
  }
}
