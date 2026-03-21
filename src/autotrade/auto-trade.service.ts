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
import { formatSpotBalanceTelegramLines } from '../order/balance-telegram.format';
import { PrismaService } from '../prisma/prisma.service';

const BOT_STATE_ID = 'default';

@Injectable()
export class AutoTradeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradeService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly simulation: SimulationService,
    private readonly audit: AuditService,
    private readonly binanceSpot: BinanceSpotService,
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

    if (dryRun && o.status === 'SIMULATED') {
      const p = o.payload as SimPayload | null;
      const est = p?.estimatedProfitUsdt;
      const rt = p?.roundtrip;
      const baseLines = [
        '🔔 Автоторговля — бумага (DRY_RUN, реальной сделки нет)',
        `Пара P2P (сигнал): ${this.config.get<string>('market.asset') ?? 'USDT'}/${this.config.get<string>('market.fiat') ?? 'RUB'}`,
        `Чистый спред: ${p?.netSpreadPercent != null ? `${p.netSpreadPercent.toFixed(3)}%` : '—'}`,
        `Оценка прибыли за цикл: ${est != null ? `${est >= 0 ? '+' : ''}${est.toFixed(4)} USDT` : '—'}`,
        `Объём в расчёте (notional): ${p?.notionalUsdt ?? '—'} USDT`,
      ];
      if (rt) {
        baseLines.push(
          `Roundtrip (бумага): ${rt.chosenSide}, марк ~${rt.markPrice.toFixed(2)} USDT`,
          `TP порог: ${rt.takeProfitPercent}% к средней цене входа`,
          `После шага: позиция ~${rt.trackedBtcAfter.toFixed(8)} BTC, средняя ~${rt.avgEntryUsdtAfter.toFixed(2)} USDT/BTC`,
        );
      }
      baseLines.push(`Запись в БД: ${o.id}`);
      return baseLines.join('\n');
    }

    const pl = o.payload as SpotLivePayload | null;
    const sym = pl?.spot?.symbol ?? '—';
    const side = pl?.spot?.side ?? '—';

    if (o.status === 'FAILED') {
      return [
        '🔔 Автоторговля — Spot Binance ❌',
        `Пара: ${sym}, сторона: ${side}`,
        `Ошибка: ${pl?.error ?? '—'}`,
        `Оценка сигнала (P2P): ${pl?.estimatedStrategyPnlUsdt != null ? `${pl.estimatedStrategyPnlUsdt >= 0 ? '+' : ''}${pl.estimatedStrategyPnlUsdt.toFixed(4)} USDT` : '—'}`,
        `Запись: ${o.id}`,
      ].join('\n');
    }

    const ex = pl?.exchangeResponse ?? {};
    const oid = ex['orderId'];
    const oidStr =
      oid === undefined || oid === null
        ? '—'
        : typeof oid === 'object'
          ? JSON.stringify(oid)
          : typeof oid === 'bigint'
            ? oid.toString()
            : String(oid as string | number | boolean);
    const execQty = ex['executedQty'];
    const cumQ = ex['cummulativeQuoteQty'] ?? ex['cumQuote'];
    const qtyStr =
      typeof execQty === 'string' || typeof execQty === 'number'
        ? String(execQty)
        : '—';
    const quoteStr =
      typeof cumQ === 'string' || typeof cumQ === 'number' ? String(cumQ) : '—';

    const rt = pl?.roundtrip;
    const lines = [
      '🔔 Автоторговля — Spot Binance ✅',
      `Сделка: ${sym} ${side} (MARKET)`,
      `Исполнено базы: ${qtyStr}`,
      `Стоимость в котируемой (USDT): ${quoteStr}`,
      `Order ID биржи: ${oidStr}`,
      `Оценка сигнала по P2P (не реализ. PnL): ${pl?.estimatedStrategyPnlUsdt != null ? `${pl.estimatedStrategyPnlUsdt >= 0 ? '+' : ''}${pl.estimatedStrategyPnlUsdt.toFixed(4)} USDT` : '—'}`,
    ];
    if (rt) {
      lines.push(
        `Roundtrip: марк ~${rt.markPrice.toFixed(2)}, TP-порог ${rt.takeProfitPercent}%`,
        `После сделки: позиция ~${rt.trackedBtcAfter.toFixed(8)} BTC, средняя ~${rt.avgEntryUsdtAfter.toFixed(2)} USDT/BTC`,
      );
      if (
        rt.realizedPnlUsdtEstimate != null &&
        !Number.isNaN(rt.realizedPnlUsdtEstimate)
      ) {
        const r = rt.realizedPnlUsdtEstimate;
        lines.push(
          `Оценка реализ. PnL (SELL): ${r >= 0 ? '+' : ''}${r.toFixed(4)} USDT`,
        );
      }
    }

    const bal = await this.binanceSpot.getAccountBalances();
    if (bal.ok) {
      const spotSym =
        this.config.get<string>('binance.spotSymbol') ?? 'BTCUSDT';
      const base = spotSym.replace(/USDT$|BUSD$|FDUSD$/, '');
      const u = bal.balances.find((b) => b.asset === 'USDT');
      const b = bal.balances.find((x) => x.asset === base);
      lines.push('Баланс на бирже после сделки:');
      lines.push(...formatSpotBalanceTelegramLines(base, u, b));
    } else {
      lines.push(`Баланс не подтянут: ${bal.error}`);
    }

    lines.push(`Запись: ${o.id}`);
    return lines.join('\n');
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
