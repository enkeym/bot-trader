import { ExecutionMode } from './env.validation';

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    /** База Spot API; по умолчанию продакшен Binance */
    spotBaseUrl: process.env.BINANCE_SPOT_BASE_URL ?? 'https://api.binance.com',
    spotSymbol: process.env.BINANCE_SPOT_SYMBOL ?? 'SOLUSDT',
    /** Потолок quote на один MARKET BUY (USDT) */
    spotMaxQuoteUsdt: parseFloat(
      process.env.BINANCE_SPOT_MAX_QUOTE_USDT ?? '20',
    ),
    /** Потолок quote в RUB для пар вида USDTRUB (на случай смены пары) */
    spotMaxQuoteRub: parseFloat(
      process.env.BINANCE_SPOT_MAX_QUOTE_RUB ?? '50000',
    ),
    /** 0 = выкл. Лимит стоимости открытой позиции (tracked × avgEntry) в USDT */
    roundtripMaxPositionUsdt: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_MAX_POSITION_USDT ?? '0',
    ),
    /** 0 = выкл. То же в RUB для пар с RUB */
    roundtripMaxPositionRub: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_MAX_POSITION_RUB ?? '0',
    ),
    /** 0 = выкл. Аварийный выход: падение марка от пика на N % */
    roundtripEmergencyDrawdownPercent: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_EMERGENCY_DRAWDOWN_PERCENT ?? '3',
    ),
    /** 0 = выкл. Cooldown после SELL, закрывшего позицию, перед следующим BUY (мс) */
    buyCooldownAfterSellMs: parseInt(
      process.env.BINANCE_SPOT_BUY_COOLDOWN_AFTER_SELL_MS ?? '600000',
      10,
    ),
    /** 0 = выкл. Расхождение free базы vs учётной позиции в % (блокирует SELL если < tracked) */
    roundtripBalanceDivergenceMaxPct: parseFloat(
      process.env.BINANCE_SPOT_BALANCE_DIVERGENCE_MAX_PCT ?? '3',
    ),
    /** Окно допустимого сдвига timestamp для подписанных запросов (мс), макс. 60000 */
    recvWindowMs: Math.min(
      60_000,
      Math.max(
        5_000,
        parseInt(process.env.BINANCE_RECV_WINDOW_MS ?? '60000', 10),
      ),
    ),
  },
  executionMode:
    (process.env.EXECUTION_MODE as ExecutionMode) ??
    ExecutionMode.AUTO_EXCHANGE_ONLY,
  strategy: {
    /** Номинальный потолок на сделку (USDT). Сайзинг по риску урежет ниже. */
    maxNotionalUsdt: parseFloat(process.env.MAX_NOTIONAL_USDT ?? '20'),
    /** Дневной стоп по суммарному убытку (USDT). 0 = выкл. */
    dailyMaxLossUsdt: parseFloat(process.env.DAILY_MAX_LOSS_USDT ?? '50'),
    /** 0 = выкл. Макс. число исполненных Spot-ордеров за сутки (UTC). */
    maxDailySpotTrades: parseInt(process.env.MAX_DAILY_SPOT_TRADES ?? '0', 10),
    /** 0 = выкл. Пауза на lossStreakCooldownMs после N подряд убыточных SELL. */
    maxConsecutiveLossSells: parseInt(
      process.env.MAX_CONSECUTIVE_LOSS_SELLS ?? '5',
      10,
    ),
    /** Cooldown после серии убытков (мс). По умолчанию 30 мин. */
    lossStreakCooldownMs: parseInt(
      process.env.LOSS_STREAK_COOLDOWN_MS ?? '1800000',
      10,
    ),
    /** Комиссия taker на одну сторону (%). Binance Spot по умолчанию 0.1. */
    spotTakerFeePercent: parseFloat(
      process.env.SPOT_TAKER_FEE_PERCENT ?? '0.1',
    ),
    /** Риск на сделку как % от эквити (для сайзинга: notional = risk / SL%). */
    riskPerTradePercent: parseFloat(process.env.RISK_PER_TRADE_PERCENT ?? '1'),
    /** Минимальная чистая прибыль TP сверх 2× комиссии (%). */
    minNetTpPercent: parseFloat(process.env.MIN_NET_TP_PERCENT ?? '0.3'),
    /** Минимальный notional ордера (USDT). Дополнительная защита к min notional биржи. */
    minOrderNotionalUsdt: parseFloat(
      process.env.MIN_ORDER_NOTIONAL_USDT ?? '10',
    ),
    /** Период ATR (свечи 1h). */
    atrPeriod: parseInt(process.env.ATR_PERIOD ?? '14', 10),
    /** Множитель ATR для стоп-лосса (SL = entry − multSL × ATR). */
    atrSlMult: parseFloat(process.env.ATR_SL_MULT ?? '1.0'),
    /** Множитель ATR для тейк-профита (TP = entry + multTP × ATR). */
    atrTpMult: parseFloat(process.env.ATR_TP_MULT ?? '2.0'),
    /** После какого профита в ATR включаем трейлинг-стоп. */
    atrTrailActivationMult: parseFloat(
      process.env.ATR_TRAIL_ACTIVATION_MULT ?? '1.0',
    ),
    /** Минимальный ADX(14) для входа (boковик = skip). */
    adxMin: parseFloat(process.env.ADX_MIN ?? '20'),
    /** Период быстрой EMA (1h). */
    emaFast: parseInt(process.env.EMA_FAST ?? '20', 10),
    /** Период средней EMA (1h) — основной фильтр тренда. */
    emaSlow: parseInt(process.env.EMA_SLOW ?? '50', 10),
    /** Период длинной EMA (1h) — макро-фильтр. */
    emaLong: parseInt(process.env.EMA_LONG ?? '200', 10),
    /** Диапазон RSI(14) для входа (откат, не перекупленность). */
    rsiEntryMin: parseFloat(process.env.RSI_ENTRY_MIN ?? '40'),
    rsiEntryMax: parseFloat(process.env.RSI_ENTRY_MAX ?? '65'),
    /** Сколько 4h свечей назад смотреть на swing low. */
    swingLookback4h: parseInt(process.env.SWING_LOOKBACK_4H ?? '12', 10),
  },
  ai: {
    geminiEnabled: process.env.GEMINI_ENABLED === 'true',
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-1.5-flash-latest',
    /** Если consulted=true и confidence ниже порога — пропуск входа. */
    minConfidence: parseFloat(process.env.GEMINI_MIN_CONFIDENCE ?? '60'),
    /** TTL кэша решений (мс). */
    cacheMs: parseInt(process.env.GEMINI_CACHE_MS ?? '600000', 10),
  },
  autoTrade: {
    /** Интервал тика авто-торговли (мс), по умолчанию 3 мин */
    intervalMs: parseInt(process.env.AUTO_TRADE_INTERVAL_MS ?? '180000', 10),
    /** UTC окно `08:00-21:00` или пусто = без фильтра по часам */
    tradingWindowUtc: process.env.TRADING_WINDOW_UTC ?? '',
    /** UTC дни: `1-5` (Пн–Пт), пусто = все дни */
    tradingDaysUtc: process.env.TRADING_DAYS_UTC ?? '',
    /**
     * 0 = выкл. При заданном STATS_EQUITY_BASELINE_USDT — пауза автоторговли,
     * если эквити упало ниже baseline более чем на N %.
     */
    maxEquityDrawdownPercent: parseFloat(
      process.env.AUTO_TRADE_MAX_EQUITY_DRAWDOWN_PERCENT ?? '15',
    ),
  },
  stats: {
    equityBaselineQuote: (() => {
      const v = process.env.STATS_EQUITY_BASELINE_USDT?.trim();
      if (!v) return null;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    })(),
  },
  marketStats: {
    cacheTtlSec: parseInt(process.env.MARKET_STATS_CACHE_TTL_SEC ?? '120', 10),
    /** Символ для /api/v3/klines; пусто = BINANCE_SPOT_SYMBOL */
    klinesSymbol: (process.env.MARKET_STATS_SYMBOL ?? '').trim(),
    fallbackKlinesSymbol: (
      process.env.MARKET_STATS_FALLBACK_SYMBOL ?? 'BTCUSDT'
    ).trim(),
  },
});
