import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'crypto';

export interface GeminiEntryContext {
  symbol: string;
  markPrice: number;
  ema20: number;
  ema50: number;
  ema200: number;
  ema50_4h: number;
  rsi14: number;
  adx14: number;
  atr14: number;
  slPercent: number;
  tpPercent: number;
  /** Последние 20 закрытий 1h (для контекста). */
  recentCloses1h: number[];
  /** Последние 10 закрытий 4h. */
  recentCloses4h: number[];
}

export interface GeminiDecision {
  /** Совет: принимать вход или нет. null = сервис недоступен. */
  action: 'BUY' | 'SKIP' | null;
  /** Уверенность 0..100; null при недоступности. */
  confidence: number | null;
  reason: string;
  /** true, если модель реально ответила (а не fail-open). */
  consulted: boolean;
}

type CacheEntry = { at: number; decision: GeminiDecision };

type RateLimitState = { blockedUntil: number };

/**
 * Gemini 1.5 Flash подтверждение входа. Работает в режиме fail-open:
 * при любых ошибках / отсутствии ключа возвращает `consulted=false`,
 * чтобы стратегия не блокировалась из-за внешнего сервиса.
 */
@Injectable()
export class GeminiService {
  private readonly log = new Logger(GeminiService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly rate: RateLimitState = { blockedUntil: 0 };

  constructor(private readonly config: ConfigService) {}

  private enabled(): boolean {
    const flag = this.config.get<boolean>('ai.geminiEnabled') ?? false;
    const key = this.config.get<string>('ai.geminiApiKey')?.trim() ?? '';
    return flag && key.length > 0;
  }

  async confirmEntry(ctx: GeminiEntryContext): Promise<GeminiDecision> {
    if (!this.enabled()) {
      return failOpen('gemini_disabled');
    }
    if (Date.now() < this.rate.blockedUntil) {
      return failOpen('gemini_rate_limited');
    }

    const cacheKey = this.buildCacheKey(ctx);
    const ttl = this.config.get<number>('ai.cacheMs') ?? 600_000;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < ttl) {
      return cached.decision;
    }

    const key = this.config.get<string>('ai.geminiApiKey')?.trim() ?? '';
    const model =
      this.config.get<string>('ai.geminiModel')?.trim() ||
      'gemini-1.5-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const prompt = buildPrompt(ctx);
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 200,
        responseMimeType: 'application/json',
      },
    };

    try {
      const res = await axios.post(url, body, {
        timeout: 5_000,
        validateStatus: () => true,
      });
      if (res.status === 429) {
        this.rate.blockedUntil = Date.now() + 15 * 60_000;
        this.log.warn('Gemini 429 — пауза 15 мин, техничка без AI');
        return failOpen('gemini_429');
      }
      if (res.status < 200 || res.status >= 300) {
        this.log.warn(`Gemini HTTP ${res.status}`);
        return failOpen(`gemini_http_${res.status}`);
      }
      const text = extractText(res.data);
      if (!text) return failOpen('gemini_empty_response');
      const parsed = parseDecision(text);
      if (!parsed) return failOpen('gemini_parse_failed');
      const decision: GeminiDecision = { ...parsed, consulted: true };
      this.cache.set(cacheKey, { at: Date.now(), decision });
      return decision;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`Gemini error: ${msg}`);
      return failOpen('gemini_exception');
    }
  }

  private buildCacheKey(ctx: GeminiEntryContext): string {
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

function failOpen(reason: string): GeminiDecision {
  return { action: null, confidence: null, reason, consulted: false };
}

function round(n: number, fd: number): string {
  return Number.isFinite(n) ? n.toFixed(fd) : 'NaN';
}

function buildPrompt(ctx: GeminiEntryContext): string {
  const fmtArr = (arr: number[]) => arr.map((n) => n.toFixed(2)).join(',');
  return [
    'Ты помощник крипто-трейдера. Технический сетап по 1h тренд-фолловингу уже прошёл (ADX, EMA, RSI).',
    'Оцени качество этой точки входа LONG и верни СТРОГО JSON без комментариев:',
    '{"action":"BUY"|"SKIP","confidence":0-100,"reason":"одной короткой фразой"}.',
    '',
    `Символ: ${ctx.symbol}`,
    `Цена: ${ctx.markPrice.toFixed(2)}`,
    `EMA20/50/200 (1h): ${ctx.ema20.toFixed(2)} / ${ctx.ema50.toFixed(2)} / ${ctx.ema200.toFixed(2)}`,
    `EMA50 (4h): ${ctx.ema50_4h.toFixed(2)}`,
    `RSI14: ${ctx.rsi14.toFixed(1)} | ADX14: ${ctx.adx14.toFixed(1)} | ATR14: ${ctx.atr14.toFixed(3)}`,
    `План: SL −${ctx.slPercent.toFixed(2)}%, TP +${ctx.tpPercent.toFixed(2)}%`,
    `Последние 20 закрытий 1h: ${fmtArr(ctx.recentCloses1h)}`,
    `Последние 10 закрытий 4h: ${fmtArr(ctx.recentCloses4h)}`,
    '',
    'Условия риска: падающий нож, истощение тренда, контртренд 4h, перекупленность → SKIP.',
    'Выраженный бычий импульс с пулбэком и подтверждением 4h → BUY.',
  ].join('\n');
}

function extractText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = d.candidates?.[0]?.content?.parts ?? [];
  const buf = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  return buf.length > 0 ? buf : null;
}

function parseDecision(text: string): Omit<GeminiDecision, 'consulted'> | null {
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
