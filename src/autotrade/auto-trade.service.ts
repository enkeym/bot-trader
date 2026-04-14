import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { BinanceSpotService } from '../binance/binance-spot.service';
import { AuditService } from '../audit/audit.service';
import {
  SpotLivePayload,
  SimulationService,
} from '../order/simulation.service';
import {
  formatSpotBalanceShortLines,
  parseSpotExchangeFill,
} from '../order/balance-telegram.format';
import { PrismaService } from '../prisma/prisma.service';
import {
  AutotradeCircuitBlocked,
  RiskService,
} from '../risk/risk.service';

const BOT_STATE_ID = 'default';
const AUTOTRADE_SKIP_AUDIT_MS = 600_000;
const BTN_STATS = '📊 Статистика';
const BTN_AUTO_ON = '▶️ Включить автоторговлю';

@Injectable()
export class AutoTradeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradeService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private lastScheduleSkipAuditAt = 0;
  private lastDailyLimitAuditAt = 0;
  private lastCircuitAuditAt = 0;
  /** Дубли Telegram по одному эпизоду просадки эквити */
  private lastCircuitTelegramNotifyKey = '';
  /**
   * Серия убыточных SELL уже привела к авто-выключению; сбрасывается, когда серия в БД прерывается.
   * Пока true — повторно не выключаем (можно снова включить автоторговлю вручную).
   */
  private consecutiveLossAutoOffLatched = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly simulation: SimulationService,
    private readonly audit: AuditService,
    private readonly binanceSpot: BinanceSpotService,
    private readonly risk: RiskService,
  ) {}

  async onModuleInit() {
    await this.prisma.botState.upsert({
      where: { id: BOT_STATE_ID },
      create: { id: BOT_STATE_ID, autoTradeEnabled: false },
      update: {},
    });
    const ms = this.config.get<number>('autoTrade.intervalMs') ?? 180_000;
    this.intervalRef = setInterval(() => void this.tick(), ms);
    this.logger.log(
      `Auto-trade tick каждые ${ms} ms — Spot MARKET при сигнале (` +
        (this.config.get<string>('binance.spotBaseUrl') ??
          'https://api.binance.com') +
        ')',
    );
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  async getState() {
    return this.prisma.botState.findUniqueOrThrow({
      where: { id: BOT_STATE_ID },
    });
  }

  async setEnabled(enabled: boolean, notifyChatId?: string) {
    return this.prisma.botState.update({
      where: { id: BOT_STATE_ID },
      data: {
        autoTradeEnabled: enabled,
        ...(notifyChatId != null ? { notifyChatId } : {}),
      },
    });
  }

  private async tick() {
    let enabled = false;
    try {
      const st = await this.getState();
      enabled = st.autoTradeEnabled;
    } catch (e) {
      this.logger.warn(`BotState: ${e}`);
      return;
    }
    if (!enabled) return;

    const now = new Date();
    if (!this.risk.isWithinAutotradeTradingSchedule(now)) {
      const t = Date.now();
      if (t - this.lastScheduleSkipAuditAt >= AUTOTRADE_SKIP_AUDIT_MS) {
        this.lastScheduleSkipAuditAt = t;
        void this.audit.log('info', 'autotrade_skipped_trading_schedule', {
          utc: now.toISOString(),
        });
      }
      return;
    }

    const daily = await this.risk.checkAutotradeDailyLimits(now);
    if (!daily.ok) {
      const t = Date.now();
      if (t - this.lastDailyLimitAuditAt >= AUTOTRADE_SKIP_AUDIT_MS) {
        this.lastDailyLimitAuditAt = t;
        void this.audit.log('info', 'autotrade_skipped_daily_limit', {
          reason: daily.reason,
          utc: now.toISOString(),
        });
      }
      return;
    }

    const lossStreak = await this.risk.hasConsecutiveLossStreak();
    if (!lossStreak) {
      this.consecutiveLossAutoOffLatched = false;
    } else if (!this.consecutiveLossAutoOffLatched) {
      this.consecutiveLossAutoOffLatched = true;
      const n =
        this.config.get<number>('strategy.maxConsecutiveLossSells') ?? 0;
      await this.setEnabled(false);
      void this.audit.log('info', 'autotrade_disabled_consecutive_loss_sells', {
        utc: now.toISOString(),
        maxConsecutiveLossSells: n,
      });
      void this.notifyAutotradeDisabledByLossStreak(n);
      return;
    }

    const circuit = await this.risk.checkAutotradeCircuitBreakers(now);
    if (!circuit.ok) {
      const notifyKey = `equity:${circuit.reason}`;
      if (notifyKey !== this.lastCircuitTelegramNotifyKey) {
        this.lastCircuitTelegramNotifyKey = notifyKey;
        void this.notifyUserCircuitBlocked(circuit);
      }
      const t = Date.now();
      if (t - this.lastCircuitAuditAt >= AUTOTRADE_SKIP_AUDIT_MS) {
        this.lastCircuitAuditAt = t;
        void this.audit.log('info', 'autotrade_skipped_circuit', {
          reason: circuit.reason,
          utc: now.toISOString(),
        });
      }
      return;
    }

    this.lastCircuitTelegramNotifyKey = '';

    const maxNotional =
      this.config.get<number>('strategy.maxNotionalUsdt') ?? 500;

    try {
      const res = await this.simulation.runPairSimulation(maxNotional);
      if (!res.ok || !res.orderCreated || !res.order) return;

      const chatId = await this.resolveNotifyChatId();
      if (!chatId) return;

      const text = await this.buildTradeNotification(res);
      await this.sendTelegram(chatId, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`autotrade tick: ${msg}`);
    }
  }

  private async buildTradeNotification(
    res: Awaited<ReturnType<SimulationService['runPairSimulation']>>,
  ): Promise<string> {
    const o = res.order;
    if (!o) return '';

    const spotSym = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const pairFil = await this.binanceSpot.getLotSizeFilter(spotSym);
    const baseAsset = pairFil.ok
      ? pairFil.baseAsset
      : spotSym.replace(/USDT$|BUSD$|FDUSD$/, '') || 'SOL';
    const quoteAsset = pairFil.ok ? pairFil.quoteAsset : 'USDT';

    const pl = o.payload as SpotLivePayload | null;
    if (o.status === 'FAILED') {
      return [
        '⚠️ Ордер не исполнен',
        `📊 Пара: ${pl?.spot?.symbol ?? spotSym}`,
        `❗ ${pl?.error ?? 'ошибка'}`,
      ].join('\n');
    }

    const ex = pl?.exchangeResponse ?? {};
    const { baseQty, quoteQty } = parseSpotExchangeFill(ex);
    const side = pl?.spot?.side;
    const rtp = pl?.roundtrip?.realizedPnlUsdtEstimate;
    const exitKind = pl?.roundtrip?.exitKind;

    const sym = pl?.spot?.symbol ?? spotSym;
    const qa = pl?.spot?.quoteAsset ?? quoteAsset;
    const ba = pl?.spot?.baseAsset ?? baseAsset;
    const exitWhy =
      exitKind === 'stop_loss'
        ? 'Стоп-лосс: марк ниже порога от средней входа.'
        : exitKind === 'emergency_drawdown'
          ? 'Аварийный выход: просадка марка от пика по стратегии.'
          : exitKind === 'take_profit'
            ? 'Тейк-профит: марк выше порога от средней входа (не из-за стопа и не «аварийно»).'
            : null;

    const head: string[] = [];

    if (
      side === 'BUY' &&
      Number.isFinite(baseQty) &&
      Number.isFinite(quoteQty)
    ) {
      const bq = Number(baseQty);
      const qq = Number(quoteQty);
      const px = bq > 0 ? qq / bq : NaN;
      head.push(
        `🟢 Покупка ${sym}`,
        `${bq.toFixed(8)} ${ba} по ~${Number.isFinite(px) ? px.toFixed(2) : '—'} ${qa} за 1 ${ba} · списано ${qq.toFixed(4)} ${qa}`,
      );
    } else if (
      side === 'SELL' &&
      Number.isFinite(baseQty) &&
      Number.isFinite(quoteQty)
    ) {
      const bq = Number(baseQty);
      const qq = Number(quoteQty);
      const px = bq > 0 ? qq / bq : NaN;
      if (exitKind === 'stop_loss') {
        head.push('🛡 Срабатывание стоп-лосса (roundtrip)');
      }
      head.push(`🔴 Продажа ${sym}`);
      if (exitWhy != null) {
        head.push(exitWhy);
      } else {
        head.push('Тип выхода в payload не указан.');
      }
      head.push(
        `${bq.toFixed(8)} ${ba} по ~${Number.isFinite(px) ? px.toFixed(2) : '—'} ${qa} за 1 ${ba} · выручка ${qq.toFixed(4)} ${qa}`,
      );
      if (rtp != null && Number.isFinite(rtp)) {
        const cost = qq - rtp;
        const pct = cost > 0 ? ((rtp / cost) * 100).toFixed(2) : '—';
        head.push(
          `По учёту за партию: ${cost.toFixed(4)} ${qa} → ${rtp >= 0 ? '+' : ''}${rtp.toFixed(4)} ${qa}${pct !== '—' ? ` (${pct}% к входу)` : ''}`,
        );
      }
    } else {
      head.push(
        '✅ Исполнено на бирже',
        `📊 Пара: ${sym}`,
        `ℹ️ ${side ?? '—'} — объём в ответе не распознан`,
      );
    }

    const bal = await this.binanceSpot.getAccountBalances();
    if (bal.ok) {
      const qRow = bal.balances.find((b) => b.asset === qa);
      const bRow = bal.balances.find((x) => x.asset === ba);
      head.push('');
      head.push('Баланс Spot:');
      const balLines = formatSpotBalanceShortLines(qa, ba, qRow, bRow);
      for (const line of balLines) {
        head.push(line);
      }
    } else {
      head.push('');
      head.push(`Баланс: ${bal.error}`);
    }

    if (side === 'BUY' || side === 'SELL') {
      try {
        const agg = await this.simulation.getSpotExecutedAgg();
        if (agg.sellCount > 0) {
          const p = agg.profitFromSellsUsdt;
          head.push('');
          head.push(
            `Всего реализ. по Spot (оценка бота): ${p >= 0 ? '+' : ''}${p.toFixed(4)} ${qa} (${agg.sellCount} продаж)`,
          );
        }
      } catch {
        /* ignore */
      }
    }

    return head.join('\n');
  }

  private async resolveNotifyChatId(): Promise<string | null> {
    const fromEnv = this.config.get<string>('telegramAlertChatId');
    if (fromEnv?.trim()) return fromEnv.trim();
    try {
      const st = await this.getState();
      return st.notifyChatId?.trim() || null;
    } catch {
      return null;
    }
  }

  private async notifyUserCircuitBlocked(_circuit: AutotradeCircuitBlocked) {
    const chatId = await this.resolveNotifyChatId();
    if (!chatId) return;

    const body =
      'Автоторговля на паузе (тик не торгует): просадка портфеля относительно STATS_EQUITY_BASELINE_USDT выше лимита AUTO_TRADE_MAX_EQUITY_DRAWDOWN_PERCENT. Можно выключить автоторговлю или изменить лимиты в .env.';

    const text = ['⏸️ Блокировка автоторговли (просадка эквити)', '', body].join(
      '\n',
    );
    await this.sendTelegram(chatId, text);
  }

  private async notifyAutotradeDisabledByLossStreak(n: number) {
    const chatId = await this.resolveNotifyChatId();
    if (!chatId) return;

    const text = [
      '⏹️ Автоторговля выключена',
      '',
      `Подряд ${n} убыточных продаж Spot (часто выходы по стоп-лоссу). Флаг autoTrade выставлен в ВЫКЛ — как при команде «выключить автоторговлю».`,
      '',
      'Команды бота снова в обычном режиме. Когда будете готовы, включите автоторговлю сами.',
    ].join('\n');
    await this.sendTelegram(chatId, text, {
      keyboard: [[{ text: BTN_STATS }], [{ text: BTN_AUTO_ON }]],
      resize_keyboard: true,
      is_persistent: true,
    });
  }

  private async sendTelegram(
    chatId: string,
    text: string,
    replyMarkup?: {
      keyboard: Array<Array<{ text: string }>>;
      resize_keyboard?: boolean;
      is_persistent?: boolean;
    },
  ) {
    const token = this.config.get<string>('telegramBotToken');
    if (!token) return;
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      { timeout: 15_000 },
    );
  }
}
