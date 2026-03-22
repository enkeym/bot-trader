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
  SimPayload,
  SpotLivePayload,
  SimulationService,
} from '../order/simulation.service';
import {
  formatSpotBalanceShortLines,
  parseSpotExchangeFill,
} from '../order/balance-telegram.format';
import { PrismaService } from '../prisma/prisma.service';
import { RiskService } from '../risk/risk.service';

const BOT_STATE_ID = 'default';
const AUTOTRADE_SKIP_AUDIT_MS = 600_000;

@Injectable()
export class AutoTradeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradeService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private lastScheduleSkipAuditAt = 0;
  private lastDailyLimitAuditAt = 0;

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
    const dryRun = this.config.get<boolean>('dryRun') ?? true;
    this.intervalRef = setInterval(() => void this.tick(), ms);
    this.logger.log(
      `Auto-trade tick каждые ${ms} ms — ` +
        (dryRun
          ? 'DRY_RUN=true: записи SIMULATED, Spot не вызывается'
          : 'DRY_RUN=false: при ключах Spot — реальные ордера на BINANCE_SPOT_BASE_URL'),
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

    const maxNotional =
      this.config.get<number>('strategy.maxNotionalUsdt') ?? 500;
    const dryRun = this.config.get<boolean>('dryRun') ?? true;

    try {
      const res = await this.simulation.runPairSimulation(maxNotional);
      if (!res.ok || !res.orderCreated || !res.order) return;

      const chatId =
        this.config.get<string>('telegramAlertChatId') ??
        (await this.getState()).notifyChatId;
      if (!chatId) return;

      const text = await this.buildTradeNotification(res, dryRun);
      await this.sendTelegram(chatId, text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`autotrade tick: ${msg}`);
    }
  }

  private async buildTradeNotification(
    res: Awaited<ReturnType<SimulationService['runPairSimulation']>>,
    dryRun: boolean,
  ): Promise<string> {
    const o = res.order;
    if (!o) return '';

    const spotSym = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const pairFil = await this.binanceSpot.getLotSizeFilter(spotSym);
    const baseAsset = pairFil.ok
      ? pairFil.baseAsset
      : spotSym.replace(/USDT$|BUSD$|FDUSD$/, '') || 'SOL';
    const quoteAsset = pairFil.ok ? pairFil.quoteAsset : 'USDT';

    if (dryRun && o.status === 'SIMULATED') {
      const p = o.payload as SimPayload | null;
      const rt = p?.roundtrip;
      if (rt) {
        const exitPaper =
          rt.chosenSide === 'SELL'
            ? rt.exitKind === 'stop_loss'
              ? ' · 🛡 стоп'
              : rt.exitKind === 'emergency_drawdown'
                ? ' · ⚡ аварийный выход'
                : rt.exitKind === 'take_profit'
                  ? ' · 🎯 тейк'
                  : ''
            : '';
        const lines =
          rt.chosenSide === 'BUY'
            ? [
                '🟢 ПОКУПКА',
                `📊 Пара: ${spotSym}`,
                '',
                `💱 Курс в шаге: ~${rt.markPrice.toFixed(2)} ${quoteAsset} за 1 ${baseAsset}`,
                `🪙 В учёте после шага: ${rt.trackedBtcAfter.toFixed(8)} ${baseAsset}`,
                `📈 Средняя цена входа: ~${rt.avgEntryUsdtAfter.toFixed(2)} ${quoteAsset} / ${baseAsset}`,
              ]
            : [
                '🔴 ПРОДАЖА',
                `📊 Пара: ${spotSym}${exitPaper}`,
                '',
                `💱 Курс в шаге: ~${rt.markPrice.toFixed(2)} ${quoteAsset} за 1 ${baseAsset}`,
                `🪙 В учёте после шага: ${rt.trackedBtcAfter.toFixed(8)} ${baseAsset}`,
                `📈 Средняя цена входа: ~${rt.avgEntryUsdtAfter.toFixed(2)} ${quoteAsset} / ${baseAsset}`,
              ];
        return [...lines, '', '📋 Запись в журнале · Spot не вызывался'].join(
          '\n',
        );
      }
      return [
        '📊 Сигнал стратегии',
        `🔗 Пара: ${spotSym}`,
        `💵 Объём в расчёте: ~${p?.notionalUsdt ?? '—'} (USDT в сигнале P2P)`,
        '',
        '📋 Запись в журнале · Spot не вызывался',
      ].join('\n');
    }

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
    const exitLabel =
      exitKind === 'stop_loss'
        ? '🛡 стоп-лосс'
        : exitKind === 'emergency_drawdown'
          ? '⚡ аварийный выход'
          : exitKind === 'take_profit'
            ? '🎯 тейк-профит'
            : null;

    const head: string[] = [];

    if (
      side === 'BUY' &&
      Number.isFinite(baseQty) &&
      Number.isFinite(quoteQty)
    ) {
      const bq = Number(baseQty);
      const qq = Number(quoteQty);
      head.push(
        '🟢 ПОКУПКА',
        `📊 Пара: ${sym}`,
        '',
        `💵 Списано: ${qq.toFixed(4)} ${qa}`,
        `🪙 Зачислено: ${bq.toFixed(8)} ${ba}`,
      );
    } else if (
      side === 'SELL' &&
      Number.isFinite(baseQty) &&
      Number.isFinite(quoteQty)
    ) {
      const bq = Number(baseQty);
      const qq = Number(quoteQty);
      head.push(
        '🔴 ПРОДАЖА',
        `📊 Пара: ${sym}` + (exitLabel != null ? ` · ${exitLabel}` : ''),
        '',
        `📤 Списано: ${bq.toFixed(8)} ${ba}`,
        `💵 Зачислено: ${qq.toFixed(4)} ${qa}`,
      );
      if (rtp != null && Number.isFinite(rtp)) {
        const cost = qq - rtp;
        const pct = cost > 0 ? ((rtp / cost) * 100).toFixed(2) : '—';
        head.push(
          '',
          '📒 Эта партия в учёте:',
          `   🧾 Себестоимость: ${cost.toFixed(4)} ${qa} (по средней входа)`,
          `   💰 Выручка: ${qq.toFixed(4)} ${qa}`,
          `   ${rtp >= 0 ? '📈' : '📉'} Результат: ${rtp >= 0 ? '+' : ''}${rtp.toFixed(4)} ${qa}`,
        );
        if (pct !== '—') {
          head.push(`   📊 ~${pct}% к себестоимости (не от всего депозита)`);
        }
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
      head.push('🏦 Счёт Spot сейчас');
      const balLines = formatSpotBalanceShortLines(qa, ba, qRow, bRow);
      for (const line of balLines) {
        head.push(line.startsWith(`${qa}:`) ? `💵 ${line}` : `🪙 ${line}`);
      }
    } else {
      head.push('');
      head.push(`⚠️ Баланс: ${bal.error}`);
    }

    return head.join('\n');
  }

  private async sendTelegram(chatId: string, text: string) {
    const token = this.config.get<string>('telegramBotToken');
    if (!token) return;
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text },
      { timeout: 15_000 },
    );
  }
}
