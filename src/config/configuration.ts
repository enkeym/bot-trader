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
    spotSymbol: process.env.BINANCE_SPOT_SYMBOL ?? 'BTCUSDT',
    spotOrderSide:
      (process.env.BINANCE_SPOT_ORDER_SIDE as 'BUY' | 'SELL') ?? 'BUY',
    /** Потолок quote (USDT) на один MARKET BUY при DRY_RUN=false */
    spotMaxQuoteUsdt: parseFloat(
      process.env.BINANCE_SPOT_MAX_QUOTE_USDT ?? '20',
    ),
    /** Для MARKET SELL — объём в базовом активе (напр. BTC) */
    spotQuantity: parseFloat(process.env.BINANCE_SPOT_QUANTITY ?? '0'),
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
  },
  /** Виртуальный стартовый баланс для отчёта /stats (бумага) */
  paper: {
    startingWalletUsdt: parseFloat(
      process.env.PAPER_WALLET_START_USDT ?? '10000',
    ),
  },
});
