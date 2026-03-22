import { ExecutionMode } from './env.validation';

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID,
  /**
   * P2P-алерты спреда (SpreadMonitor, раз в 5 мин). По умолчанию выкл. —
   * в чат уходят только уведомления автоторговли о покупке/продаже/ошибке сделки.
   */
  telegramSpreadAlertsEnabled:
    process.env.TELEGRAM_SPREAD_ALERTS_ENABLED === 'true',
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
    spotOrderSide:
      (process.env.BINANCE_SPOT_ORDER_SIDE as 'BUY' | 'SELL') ?? 'BUY',
    /** Потолок quote на один MARKET BUY (USDT), если котировка пары — USDT */
    spotMaxQuoteUsdt: parseFloat(
      process.env.BINANCE_SPOT_MAX_QUOTE_USDT ?? '20',
    ),
    /** Потолок quote в RUB для пар вроде USDTRUB */
    spotMaxQuoteRub: parseFloat(
      process.env.BINANCE_SPOT_MAX_QUOTE_RUB ?? '50000',
    ),
    /** Для MARKET SELL — объём в базовом активе (напр. BTC) */
    spotQuantity: parseFloat(process.env.BINANCE_SPOT_QUANTITY ?? '0'),
    /** `fixed_side` — одна сторона из BINANCE_SPOT_ORDER_SIDE; `roundtrip` — BUY/SELL по позиции и take-profit */
    spotStrategy:
      (process.env.BINANCE_SPOT_STRATEGY as 'fixed_side' | 'roundtrip') ??
      'fixed_side',
    /** Порог take-profit к средней цене входа (%, напр. 0.15 = 0.15%) */
    roundtripTakeProfitPercent: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_TAKE_PROFIT_PERCENT ?? '0.15',
    ),
    /**
     * true — при каждом сигнале докупать, пока TP не достигнут (старое поведение).
     * false — пока есть учётная позиция и TP не сработал, не BUY (ждём роста цены до SELL).
     */
    roundtripAccumulateOnSignal:
      process.env.BINANCE_SPOT_ROUNDTRIP_ACCUMULATE === 'true',
    /** 0 = выкл. Иначе продать учётную позицию, если цена ниже средней на N % (ограничение убытка). */
    roundtripStopLossPercent: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_STOP_LOSS_PERCENT ?? '0',
    ),
    /**
     * 0 = выкл. Макс. «стоимость» учётной позиции в USDT (tracked × средняя цена);
     * при докупках не даёт набирать позицию больше лимита.
     */
    roundtripMaxPositionUsdt: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_MAX_POSITION_USDT ?? '0',
    ),
    /** Лимит позиции в RUB учёта для USDTRUB (0 = выкл.) */
    roundtripMaxPositionRub: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_MAX_POSITION_RUB ?? '0',
    ),
    /** 0 = выкл. Продажа, если цена упала на N % от пика марка с момента входа (раньше глубокого SL). */
    roundtripEmergencyDrawdownPercent: parseFloat(
      process.env.BINANCE_SPOT_ROUNDTRIP_EMERGENCY_DRAWDOWN_PERCENT ?? '0',
    ),
    /** 0 = выкл. Не BUY, если σ доходностей 1h за 24h выше порога (п.п.). */
    skipBuyVolatilityStdevGt: parseFloat(
      process.env.BINANCE_SPOT_SKIP_BUY_VOLATILITY_STDDEV_GT ?? '0',
    ),
    /** 0 = выкл. Не BUY, если рост close за 24h выше N % (перегрев). */
    skipBuyChange24hGt: parseFloat(
      process.env.BINANCE_SPOT_SKIP_BUY_CHANGE_24H_GT ?? '0',
    ),
    quoteVolatilityScaleEnabled:
      process.env.BINANCE_SPOT_QUOTE_VOLATILITY_SCALE === 'true',
    /** Референсная σ (п.п.) для масштаба: при σ выше рынка quote уменьшается */
    quoteVolatilityRefStdevPp: parseFloat(
      process.env.BINANCE_SPOT_QUOTE_VOLATILITY_REF_STDDEV_PP ?? '0.2',
    ),
    /** Нижняя граница множителя к max quote (0.25 = не ниже 25% от лимита) */
    quoteVolatilityMinScale: parseFloat(
      process.env.BINANCE_SPOT_QUOTE_VOLATILITY_MIN_SCALE ?? '0.25',
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
  dryRun: process.env.DRY_RUN !== 'false',
  executionMode:
    (process.env.EXECUTION_MODE as ExecutionMode) ??
    ExecutionMode.AUTO_EXCHANGE_ONLY,
  p2pProvider: (process.env.P2P_PROVIDER ?? 'binance').trim(),
  market: {
    fiat: (process.env.FIAT ?? 'RUB').trim(),
    asset: (process.env.ASSET ?? 'USDT').trim(),
  },
  strategy: {
    minSpreadPercent: parseFloat(process.env.MIN_SPREAD_PERCENT ?? '0.15'),
    maxNotionalUsdt: parseFloat(process.env.MAX_NOTIONAL_USDT ?? '500'),
    dailyMaxLossUsdt: parseFloat(process.env.DAILY_MAX_LOSS_USDT ?? '50'),
    /** 0 = выкл. Макс. число исполненных Spot-ордеров за сутки (UTC). */
    maxDailySpotTrades: parseInt(process.env.MAX_DAILY_SPOT_TRADES ?? '0', 10),
    takerFeePercent: parseFloat(process.env.P2P_TAKER_FEE_PERCENT ?? '0'),
  },
  ton: {
    manifestUrl: process.env.TON_CONNECT_MANIFEST_URL,
    paymentRecipient: process.env.TON_PAYMENT_RECIPIENT,
    requireAccess: process.env.REQUIRE_TON_ACCESS === 'true',
  },
  autoTrade: {
    /** Интервал тика авто-симуляции (мс), по умолчанию 3 мин */
    intervalMs: parseInt(process.env.AUTO_TRADE_INTERVAL_MS ?? '180000', 10),
    /** UTC `08:00-21:00` или пусто = без фильтра по часам */
    tradingWindowUtc: process.env.TRADING_WINDOW_UTC ?? '',
    /** UTC дни: `1-5` (Пн–Пт), пусто = все дни */
    tradingDaysUtc: process.env.TRADING_DAYS_UTC ?? '',
  },
  /** Виртуальный стартовый баланс для отчёта /stats (бумага) */
  paper: {
    startingWalletUsdt: parseFloat(
      process.env.PAPER_WALLET_START_USDT ?? '10000',
    ),
  },
  /** Кэш публичной статистики свечей (market) для Telegram / внутренних проверок */
  marketStats: {
    cacheTtlSec: parseInt(process.env.MARKET_STATS_CACHE_TTL_SEC ?? '120', 10),
  },
});
