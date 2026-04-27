import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { BotState } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AuditService } from '../audit/audit.service';
import { parseSpotExchangeFill } from '../order/balance-telegram.format';
import {
  SimulationService,
  SimulationTickResult,
  SpotLivePayload,
} from '../order/simulation.service';
import {
  exitKindShort,
  fmtStatsNumber,
  fmtStatsQtyBase,
} from '../order/telegram-trading-report.format';
import { PrismaService } from '../prisma/prisma.service';
import { AutotradeCircuitBlocked, RiskService } from '../risk/risk.service';

const BOT_STATE_ID = 'default';
const AUTOTRADE_SKIP_AUDIT_MS = 600_000;
const BTN_STATS = '📊 Статистика';
const BTN_AUTO_ON = '▶️ Включить автоторговлю';

@Injectable()
export class AutoTradeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradeService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private lastScheduleSkipAuditAt = 0;
  private lastDailyLimitAuditAt = 0;
  private lastCircuitAuditAt = 0;
  private lastCircuitTelegramNotifyKey = '';

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly simulation: SimulationService,
    private readonly audit: AuditService,
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
      `Auto-trade tick каждые ${ms} ms · ${this.config.get<string>('binance.spotBaseUrl') ?? 'https://api.binance.com'}`,
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
    if (this.inFlight) {
      this.logger.warn('tick: предыдущий вызов ещё в процессе, пропуск');
      return;
    }
    this.inFlight = true;
    try {
      await this.runTick();
    } finally {
      this.inFlight = false;
    }
  }

  private async runTick() {
    let st: BotState;
    try {
      st = await this.getState();
    } catch (e) {
      this.logger.warn(`BotState: ${e}`);
      return;
    }
    if (!st.autoTradeEnabled) return;

    const now = new Date();
    if (!this.risk.isWithinAutotradeTradingSchedule(now)) {
      this.maybeAudit('lastScheduleSkipAuditAt', () =>
        this.audit.log('info', 'autotrade_skipped_trading_schedule', {
          utc: now.toISOString(),
        }),
      );
      return;
    }

    const daily = await this.risk.checkAutotradeDailyLimits(now);
    if (!daily.ok) {
      this.maybeAudit('lastDailyLimitAuditAt', () =>
        this.audit.log('info', 'autotrade_skipped_daily_limit', {
          reason: daily.reason,
          utc: now.toISOString(),
        }),
      );
      return;
    }

    const pauseUntil = st.lossStreakPauseUntilAt;
    if (pauseUntil && pauseUntil.getTime() > Date.now()) {
      this.maybeAudit('lastDailyLimitAuditAt', () =>
        this.audit.log('info', 'autotrade_paused_loss_streak_tick', {
          resumeAt: pauseUntil.toISOString(),
        }),
      );
      return;
    }

    const { active: lossStreak, fingerprint } =
      await this.risk.getConsecutiveLossStreakInfo();
    const ackFp = st.lossStreakAckFingerprint ?? '';

    if (lossStreak) {
      if (fingerprint !== ackFp) {
        const n =
          this.config.get<number>('strategy.maxConsecutiveLossSells') ?? 0;
        const cooldownMs =
          this.config.get<number>('strategy.lossStreakCooldownMs') ?? 0;
        const effectiveCooldown = cooldownMs > 0 ? cooldownMs : 30 * 60_000;
        const resume = new Date(Date.now() + effectiveCooldown);
        await this.prisma.botState.update({
          where: { id: BOT_STATE_ID },
          data: {
            lossStreakAckFingerprint: fingerprint,
            lossStreakPauseUntilAt: resume,
          },
        });
        void this.audit.log('info', 'autotrade_paused_loss_streak', {
          maxConsecutiveLossSells: n,
          cooldownMs: effectiveCooldown,
          resumeAt: resume.toISOString(),
        });
        void this.notifyLossStreakPause(n, effectiveCooldown);
        return;
      }
    } else if (st.lossStreakAckFingerprint != null || st.lossStreakPauseUntilAt != null) {
      await this.prisma.botState.update({
        where: { id: BOT_STATE_ID },
        data: {
          lossStreakAckFingerprint: null,
          lossStreakPauseUntilAt: null,
        },
      });
    }

    const circuit = await this.risk.checkAutotradeCircuitBreakers();
    if (!circuit.ok) {
      const key = `equity:${circuit.reason}`;
      if (key !== this.lastCircuitTelegramNotifyKey) {
        this.lastCircuitTelegramNotifyKey = key;
        void this.notifyCircuitBlocked(circuit);
      }
      this.maybeAudit('lastCircuitAuditAt', () =>
        this.audit.log('info', 'autotrade_skipped_circuit', {
          reason: circuit.reason,
        }),
      );
      return;
    }
    this.lastCircuitTelegramNotifyKey = '';

    const maxNotional =
      this.config.get<number>('strategy.maxNotionalUsdt') ?? 20;

    try {
      const res = await this.simulation.runPairSimulation(maxNotional);
      if (!res.ok || !res.orderCreated || !res.order) return;
      const chatId = await this.resolveNotifyChatId();
      if (!chatId) return;
      const text = this.buildTradeNotification(res);
      await this.sendTelegram(chatId, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`autotrade tick: ${msg}`);
    }
  }

  private maybeAudit(
    key:
      | 'lastScheduleSkipAuditAt'
      | 'lastDailyLimitAuditAt'
      | 'lastCircuitAuditAt',
    fn: () => void | Promise<unknown>,
  ) {
    const t = Date.now();
    if (t - this[key] >= AUTOTRADE_SKIP_AUDIT_MS) {
      this[key] = t;
      void fn();
    }
  }

  private buildTradeNotification(res: SimulationTickResult): string {
    const o = res.order;
    if (!o) return '';
    const pl = o.payload as SpotLivePayload | null;
    const testnetPrefix = res.isTestnet ? '⚠️ TESTNET\n' : '';

    if (o.status === 'FAILED') {
      return `${testnetPrefix}⚠️ ${pl?.error ?? 'ошибка'}`;
    }

    const ex = pl?.exchangeResponse ?? {};
    const { baseQty, quoteQty } = parseSpotExchangeFill(ex);
    const side = pl?.spot?.side;
    const ba = pl?.spot?.baseAsset ?? 'SOL';
    const bq = Number(baseQty);
    const qq = Number(quoteQty);
    const px = bq > 0 ? qq / bq : NaN;

    if (side === 'BUY') {
      return `${testnetPrefix}🟢 Купил ${fmtStatsQtyBase(bq)} ${ba} @ ${fmtStatsNumber(px, 2, 2)} (−${fmtStatsNumber(qq, 2, 2)}$)`;
    }
    if (side === 'SELL') {
      const icon = exitKindShort(pl?.roundtrip?.exitKind);
      const rtp = pl?.roundtrip?.realizedPnlUsdtEstimate;
      let pnlStr = '';
      if (rtp != null && Number.isFinite(rtp)) {
        const proceeds = qq;
        const cost = proceeds - rtp;
        const pct = cost > 0 ? (rtp / cost) * 100 : NaN;
        const sign = rtp >= 0 ? '+' : '';
        pnlStr = ` ${sign}${fmtStatsNumber(rtp, 2, 2)}$`;
        if (Number.isFinite(pct)) {
          pnlStr += ` / ${sign}${fmtStatsNumber(pct, 2, 2)}%`;
        }
      }
      return `${testnetPrefix}${icon} Продал ${fmtStatsQtyBase(bq)} ${ba} @ ${fmtStatsNumber(px, 2, 2)}${pnlStr}`;
    }
    return `${testnetPrefix}✅ Исполнено · ${side ?? '—'}`;
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

  private async notifyCircuitBlocked(_circuit: AutotradeCircuitBlocked) {
    void _circuit;
    const chatId = await this.resolveNotifyChatId();
    if (!chatId) return;
    await this.sendTelegram(chatId, '⏸️ Пауза · просадка эквити ниже лимита');
  }

  private async notifyLossStreakPause(n: number, cooldownMs: number) {
    const chatId = await this.resolveNotifyChatId();
    if (!chatId) return;
    const mins = Math.round(cooldownMs / 60_000);
    await this.sendTelegram(chatId, `⏸️ Пауза ${mins}м · ${n} убытков подряд`, {
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
    try {
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: chatId,
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
        { timeout: 15_000 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`telegram send: ${msg}`);
    }
  }
}
