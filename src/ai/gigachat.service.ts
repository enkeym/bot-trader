import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosRequestConfig } from 'axios';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { Agent as HttpsAgent } from 'https';

export interface AiEntryContext {
  symbol: string;
  markPrice: number;
  ema20: number;
  ema50: number;
  ema200: number;
  ema50_4h: number;
  rsi14: number;
  adx14: number;
  atr14: number;
  atrPercent?: number;
  slPercent: number;
  tpPercent: number;
  recentCloses1h: number[];
  recentCloses4h: number[];
}

export interface AiDecision {
  action: 'BUY' | 'SKIP' | null;
  confidence: number | null;
  reason: string;
  consulted: boolean;
}

type CacheEntry = { at: number; decision: AiDecision };
type RateLimitState = { blockedUntil: number };
type TokenState = { token: string; expiresAt: number };

const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * GigaChat (Сбер): подтверждение входа. Fail-open при ошибках.
 */
@Injectable()
export class GigaChatService {
  private readonly log = new Logger(GigaChatService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly rate: RateLimitState = { blockedUntil: 0 };
  private tokenState: TokenState | null = null;
  private tokenRefreshPromise: Promise<string | null> | null = null;
  private httpsAgent: HttpsAgent | null = null;

  constructor(private readonly config: ConfigService) {}

  private enabled(): boolean {
    const flag = this.config.get<boolean>('ai.gigachat.enabled') ?? false;
    const auth = this.config.get<string>('ai.gigachat.auth')?.trim() ?? '';
    return flag && auth.length > 0;
  }

  async confirmEntry(ctx: AiEntryContext): Promise<AiDecision> {
    if (!this.enabled()) return failOpen('gigachat_disabled');
    if (Date.now() < this.rate.blockedUntil) {
      return failOpen('gigachat_rate_limited');
    }

    const cacheKey = this.buildCacheKey(ctx);
    const ttl = this.config.get<number>('ai.gigachat.cacheMs') ?? 600_000;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttl) {
      return cached.decision;
    }

    const token = await this.ensureToken();
    if (!token) return failOpen('gigachat_oauth_failed');

    const decision = await this.requestDecision(ctx, token);
    if (decision.consulted) {
      this.cache.set(cacheKey, { at: Date.now(), decision });
    }
    return decision;
  }

  private async requestDecision(
    ctx: AiEntryContext,
    token: string,
  ): Promise<AiDecision> {
    const url =
      this.config.get<string>('ai.gigachat.chatUrl') ??
      'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
    const model = this.config.get<string>('ai.gigachat.model') ?? 'GigaChat-2';

    const prompt = buildPrompt(ctx);
    const body = {
      model,
      temperature: 0.2,
      top_p: 0.1,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'Ты помощник крипто-трейдера. Отвечаешь СТРОГО валидным JSON ' +
            'без комментариев: ' +
            '{"action":"BUY"|"SKIP","confidence":0-100,"reason":"одна короткая фраза"}.',
        },
        { role: 'user', content: prompt },
      ],
    };

    try {
      const res = await axios.post(url, body, this.axiosCfg(token));
      if (res.status === 401) {
        this.tokenState = null;
        const refreshed = await this.ensureToken(true);
        if (!refreshed) return failOpen('gigachat_oauth_failed_after_401');
        const retry = await axios.post(url, body, this.axiosCfg(refreshed));
        return this.handleChatResponse(retry);
      }
      return this.handleChatResponse(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`GigaChat error: ${msg}`);
      return failOpen('gigachat_exception');
    }
  }

  private handleChatResponse(res: {
    status: number;
    data: unknown;
  }): AiDecision {
    if (res.status === 429) {
      this.rate.blockedUntil = Date.now() + 15 * 60_000;
      this.log.warn('GigaChat 429 — пауза 15 мин, техничка без AI');
      return failOpen('gigachat_429');
    }
    if (res.status < 200 || res.status >= 300) {
      this.log.warn(`GigaChat HTTP ${res.status}`);
      return failOpen(`gigachat_http_${res.status}`);
    }
    const text = extractText(res.data);
    if (!text) return failOpen('gigachat_empty_response');
    const parsed = parseDecision(text);
    if (!parsed) return failOpen('gigachat_parse_failed');
    return { ...parsed, consulted: true };
  }

  private async ensureToken(force = false): Promise<string | null> {
    if (!force) {
      const t = this.tokenState;
      if (t && t.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
        return t.token;
      }
    }
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = this.refreshToken().finally(() => {
        this.tokenRefreshPromise = null;
      });
    }
    return this.tokenRefreshPromise;
  }

  private async refreshToken(): Promise<string | null> {
    const url =
      this.config.get<string>('ai.gigachat.oauthUrl') ??
      'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
    const auth = this.config.get<string>('ai.gigachat.auth')?.trim() ?? '';
    const scope =
      this.config.get<string>('ai.gigachat.scope') ?? 'GIGACHAT_API_PERS';
    if (!auth) return null;

    const body = new URLSearchParams({ scope }).toString();
    try {
      const res = await axios.post(url, body, {
        ...this.axiosCfgBase(),
        headers: {
          Authorization: `Basic ${auth}`,
          RqUID: randomUUID(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      });
      if (res.status === 429) {
        this.rate.blockedUntil = Date.now() + 15 * 60_000;
        this.log.warn('GigaChat OAuth 429 — пауза 15 мин');
        return null;
      }
      if (res.status < 200 || res.status >= 300) {
        this.log.warn(`GigaChat OAuth HTTP ${res.status}`);
        return null;
      }
      const data = res.data as {
        access_token?: string;
        expires_at?: number;
      } | null;
      const token = data?.access_token?.trim();
      const expiresAt = Number(data?.expires_at);
      if (!token) {
        this.log.warn('GigaChat OAuth: пустой access_token');
        return null;
      }
      this.tokenState = {
        token,
        expiresAt: Number.isFinite(expiresAt)
          ? expiresAt * 1000
          : Date.now() + 25 * 60_000,
      };
      return token;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`GigaChat OAuth error: ${msg}`);
      return null;
    }
  }

  private axiosCfgBase(): AxiosRequestConfig {
    return {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
      httpsAgent: this.getHttpsAgent(),
    };
  }

  private axiosCfg(token: string): AxiosRequestConfig {
    return {
      ...this.axiosCfgBase(),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        RqUID: randomUUID(),
      },
    };
  }

  private getHttpsAgent(): HttpsAgent {
    if (this.httpsAgent) return this.httpsAgent;
    const caPath = this.config.get<string>('ai.gigachat.caPath')?.trim() ?? '';
    const insecure =
      this.config.get<boolean>('ai.gigachat.insecureTls') ?? false;
    if (caPath) {
      try {
        const ca = readFileSync(caPath);
        this.httpsAgent = new HttpsAgent({ ca, keepAlive: true });
        return this.httpsAgent;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(
          `GigaChat: не удалось прочитать CA ${caPath}: ${msg}` +
            (insecure ? ' — insecure TLS' : ''),
        );
      }
    }
    this.httpsAgent = new HttpsAgent({
      keepAlive: true,
      rejectUnauthorized: !insecure,
    });
    return this.httpsAgent;
  }

  private buildCacheKey(ctx: AiEntryContext): string {
    const last1h = ctx.recentCloses1h[ctx.recentCloses1h.length - 1] ?? 0;
    const payload = [
      ctx.symbol,
      round(ctx.markPrice, 2),
      round(last1h, 2),
      round(ctx.ema20, 2),
      round(ctx.ema50, 2),
      round(ctx.rsi14, 1),
      round(ctx.adx14, 1),
      round(ctx.atr14, 3),
    ].join('|');
    return createHash('sha1').update(payload).digest('hex');
  }
}

function failOpen(reason: string): AiDecision {
  return { action: null, confidence: null, reason, consulted: false };
}

function round(n: number, fd: number): string {
  return Number.isFinite(n) ? n.toFixed(fd) : 'NaN';
}

function buildPrompt(ctx: AiEntryContext): string {
  const fmtArr = (arr: number[]) =>
    arr.length === 0 ? '—' : arr.map((n) => n.toFixed(2)).join(',');
  const atrPctStr =
    typeof ctx.atrPercent === 'number' && Number.isFinite(ctx.atrPercent)
      ? `${ctx.atrPercent.toFixed(2)}%`
      : '—';
  return [
    'Технический сетап 1h тренд-фолловинга прошёл (ADX/EMA/RSI). Оцени качество входа LONG.',
    'Верни СТРОГО JSON без комментариев:',
    '{"action":"BUY"|"SKIP","confidence":0-100,"reason":"одной короткой фразой"}.',
    '',
    `Символ: ${ctx.symbol}`,
    `Цена: ${ctx.markPrice.toFixed(2)}`,
    `EMA20/50/200 (1h): ${ctx.ema20.toFixed(2)} / ${ctx.ema50.toFixed(2)} / ${ctx.ema200.toFixed(2)}`,
    `EMA50 (4h): ${ctx.ema50_4h.toFixed(2)}`,
    `RSI14: ${ctx.rsi14.toFixed(1)} | ADX14: ${ctx.adx14.toFixed(1)} | ATR14: ${ctx.atr14.toFixed(3)} (${atrPctStr})`,
    `План: SL −${ctx.slPercent.toFixed(2)}%, TP +${ctx.tpPercent.toFixed(2)}%`,
    `Последние 20 закрытий 1h: ${fmtArr(ctx.recentCloses1h)}`,
    `Последние 10 закрытий 4h: ${fmtArr(ctx.recentCloses4h)}`,
    '',
    'Риск-флаги: падающий нож, истощение тренда, контртренд 4h, перекупленность → SKIP.',
    'Бычий импульс с откатом и подтверждением 4h → BUY.',
  ].join('\n');
}

function extractText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = d.choices?.[0]?.message?.content?.trim() ?? '';
  return text.length > 0 ? text : null;
}

function parseDecision(text: string): Omit<AiDecision, 'consulted'> | null {
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  const slice = text.slice(jsonStart, jsonEnd + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as {
    action?: unknown;
    confidence?: unknown;
    reason?: unknown;
  };
  const action = o.action === 'BUY' || o.action === 'SKIP' ? o.action : null;
  const rawConf = typeof o.confidence === 'number' ? o.confidence : NaN;
  const confidence = Number.isFinite(rawConf)
    ? Math.max(0, Math.min(100, rawConf))
    : null;
  const reason =
    typeof o.reason === 'string' && o.reason.trim().length > 0
      ? o.reason.trim().slice(0, 200)
      : 'no reason';
  if (!action || confidence == null) return null;
  return { action, confidence, reason };
}
