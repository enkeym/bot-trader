import { Injectable } from '@nestjs/common';
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

export type SpotMarketOrderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: number };

@Injectable()
export class BinanceSpotService {
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

    const timestamp = Date.now();
    const baseParams: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: 'MARKET',
      timestamp,
      recvWindow: 5000,
    };

    if (params.side === 'BUY') {
      baseParams.quoteOrderQty = Number(
        (params.quoteOrderQty as number).toFixed(8),
      );
    } else {
      baseParams.quantity = Number((params.quantity as number).toFixed(8));
    }

    const queryString = buildSignedQueryString(baseParams, cred.secret);
    const url = `${this.getBaseUrl().replace(/\/$/, '')}/api/v3/order`;

    try {
      const res = await axios.post(`${url}?${queryString}`, null, {
        headers: { 'X-MBX-APIKEY': cred.key },
        timeout: 30_000,
        validateStatus: () => true,
      });
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
    const timestamp = Date.now();
    const params: Record<string, string | number> = {
      recvWindow: 5000,
      timestamp,
    };
    const queryString = buildSignedQueryString(params, cred.secret);
    const base = this.getBaseUrl().replace(/\/$/, '');
    const url = `${base}/api/v3/account?${queryString}`;
    try {
      const res = await axios.get(url, {
        headers: { 'X-MBX-APIKEY': cred.key },
        timeout: 30_000,
        validateStatus: () => true,
      });
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
