import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  BinanceSpotService,
  SpotMarketOrderResult,
} from '../binance/binance-spot.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrderIntentService } from './order-intent.service';
import { RiskService } from '../risk/risk.service';
import { SpreadService } from '../strategy/spread.service';

/** Поля в payload OrderIntent для бумажной статистики */
export type SimPayload = {
  grossSpreadPercent: number;
  netSpreadPercent: number;
  notionalUsdt: number;
  snapshot: { bestBuy: number | null; bestSell: number | null };
  /** Оценка: notional × чистый спред % / 100 (упрощённо, не гарантия прибыли). */
  estimatedProfitUsdt: number | null;
};

/** Реальный Spot-ордер (Binance Spot API): контекст P2P + ответ биржи */
export type SpotLivePayload = {
  p2pSpreadContext: {
    grossSpreadPercent: number;
    netSpreadPercent: number;
    notionalUsdt: number;
    bestBuy: number | null;
    bestSell: number | null;
  };
  spot: {
    baseUrl: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quoteOrderQty?: number;
    quantity?: number;
  };
  exchangeResponse?: Record<string, unknown>;
  /** Оценка «сигнала» по P2P-спреду на объёме notional (не реализованный PnL Spot). */
  estimatedStrategyPnlUsdt?: number | null;
  error?: string;
  code?: number;
};

@Injectable()
export class SimulationService {
  constructor(
    private readonly spread: SpreadService,
    private readonly risk: RiskService,
    private readonly orders: OrderIntentService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly binanceSpot: BinanceSpotService,
  ) {}

  /**
   * Суммарная «бумажная» прибыль по записям SIMULATED (без реального кошелька и биржи).
   */
  async getPaperStats() {
    const rows = await this.prisma.orderIntent.findMany({
      where: { status: 'SIMULATED' },
      select: { payload: true },
    });
    let totalProfitUsdt = 0;
    let count = 0;
    for (const r of rows) {
      const p = r.payload as SimPayload | null;
      if (p?.estimatedProfitUsdt != null && p.estimatedProfitUsdt > 0) {
        totalProfitUsdt += p.estimatedProfitUsdt;
        count++;
      }
    }
    return {
      simulatedTrades: rows.length,
      tradesWithEstimate: count,
      totalEstimatedProfitUsdt: Number(totalProfitUsdt.toFixed(6)),
    };
  }

  /**
   Сводка для /stats: бумажный кошелёк, PnL по оценкам, последние сделки.
   Не связано с реальным балансом Binance.
   */
  async getPaperDashboard() {
    const all = await this.prisma.orderIntent.findMany({
      where: { status: 'SIMULATED' },
      select: { payload: true },
    });
    let totalPnL = 0;
    let tradesWithProfitLine = 0;
    for (const r of all) {
      const p = r.payload as SimPayload | null;
      if (p?.estimatedProfitUsdt != null) {
        totalPnL += p.estimatedProfitUsdt;
        if (p.estimatedProfitUsdt > 0) tradesWithProfitLine++;
      }
    }
    const start = this.config.get<number>('paper.startingWalletUsdt') ?? 10_000;
    const recent = await this.prisma.orderIntent.findMany({
      where: { status: 'SIMULATED' },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, createdAt: true, payload: true },
    });
    const recentLines = recent.map((r) => {
      const p = r.payload as SimPayload | null;
      const t = r.createdAt.toISOString().slice(0, 16).replace('T', ' ');
      const profit = p?.estimatedProfitUsdt;
      const net = p?.netSpreadPercent;
      return `${t} | спред ${net?.toFixed(2) ?? '—'}% | ~${profit?.toFixed(2) ?? '—'} USDT`;
    });
    return {
      totalSimulatedTrades: all.length,
      tradesWithPositiveEstimate: tradesWithProfitLine,
      totalEstimatedPnLUsdt: Number(totalPnL.toFixed(6)),
      startingPaperWalletUsdt: start,
      currentPaperWalletUsdt: Number((start + totalPnL).toFixed(6)),
      recentTradeLines: recentLines,
    };
  }

  async runPairSimulation(notionalUsdt: number) {
    const asset = this.config.get<string>('market.asset') ?? 'USDT';
    const fiat = this.config.get<string>('market.fiat') ?? 'RUB';
    const dryRun = this.config.get<boolean>('dryRun') ?? true;

    const ev = await this.spread.evaluate(asset, fiat);
    const gross = ev.grossSpreadPercent ?? 0;
    const net = ev.netSpreadPercent ?? 0;

    const ok = this.risk.allowSignal({
      grossSpreadPercent: gross,
      notionalUsdt,
    });

    const minuteBucket = Math.floor(Date.now() / 60_000);
    const idempotencyKey = createHash('sha256')
      .update(`${asset}-${fiat}-${minuteBucket}-${gross.toFixed(4)}`)
      .digest('hex')
      .slice(0, 32);

    const executionMode = this.config.get<string>('executionMode');

    const estimatedProfitUsdt =
      ev.netSpreadPercent != null && ev.netSpreadPercent > 0
        ? Number(((notionalUsdt * ev.netSpreadPercent) / 100).toFixed(6))
        : null;

    if (!ok) {
      await this.audit.log('info', 'simulation_skipped_risk', {
        grossSpreadPercent: gross,
        netSpreadPercent: net,
        notionalUsdt,
      });
      return {
        ev,
        ok: false,
        dryRun,
        executionMode,
        order: null,
        estimatedProfitUsdt,
        orderCreated: false,
      };
    }

    if (dryRun) {
      const payload: SimPayload = {
        grossSpreadPercent: gross,
        netSpreadPercent: net,
        notionalUsdt,
        snapshot: {
          bestBuy: ev.snapshot.bestBuyUsdtPrice,
          bestSell: ev.snapshot.bestSellUsdtPrice,
        },
        estimatedProfitUsdt,
      };

      const { record, created } = await this.orders.createIdempotent({
        idempotencyKey,
        provider: 'binance',
        side: 'P2P_SPREAD_SIM',
        status: 'SIMULATED',
        payload,
      });

      await this.audit.log(
        'info',
        created ? 'simulation_recorded' : 'simulation_idempotent_hit',
        {
          orderIntentId: record.id,
          idempotencyKey,
          grossSpreadPercent: gross,
        },
      );

      return {
        ev,
        ok: true,
        dryRun,
        executionMode,
        order: record,
        estimatedProfitUsdt,
        orderCreated: created,
      };
    }

    if (!this.binanceSpot.spotExecutionAllowed()) {
      await this.audit.log('warn', 'spot_execution_blocked', {
        message:
          'Для Spot укажите BINANCE_API_KEY и BINANCE_API_SECRET (ключи с binance.com → API Management).',
      });
      return {
        ev,
        ok: true,
        dryRun: false,
        executionMode,
        order: null,
        estimatedProfitUsdt,
        orderCreated: false,
      };
    }

    const spotBaseUrl =
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com';
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'BTCUSDT';
    const side =
      this.config.get<'BUY' | 'SELL'>('binance.spotOrderSide') ?? 'BUY';
    const maxQuote = this.config.get<number>('binance.spotMaxQuoteUsdt') ?? 20;
    const spotQty = this.config.get<number>('binance.spotQuantity') ?? 0;

    const p2pSpreadContext = {
      grossSpreadPercent: gross,
      netSpreadPercent: net,
      notionalUsdt,
      bestBuy: ev.snapshot.bestBuyUsdtPrice,
      bestSell: ev.snapshot.bestSellUsdtPrice,
    };

    const spotMeta = {
      baseUrl: spotBaseUrl,
      symbol,
      side,
      ...(side === 'BUY'
        ? { quoteOrderQty: Math.min(notionalUsdt, maxQuote) }
        : { quantity: spotQty }),
    };

    let spotResult: SpotMarketOrderResult;
    if (side === 'SELL' && spotQty <= 0) {
      spotResult = {
        ok: false,
        error:
          'Для SELL задайте BINANCE_SPOT_QUANTITY > 0 (объём в базовом активе).',
      };
    } else {
      spotResult = await this.binanceSpot.placeMarketOrder(
        side === 'BUY'
          ? {
              symbol,
              side: 'BUY',
              quoteOrderQty: Math.min(notionalUsdt, maxQuote),
            }
          : {
              symbol,
              side: 'SELL',
              quantity: spotQty,
            },
      );
    }

    const spotKey = `spot-${idempotencyKey}`;

    if (!spotResult.ok) {
      const failPayload: SpotLivePayload = {
        p2pSpreadContext,
        spot: spotMeta,
        estimatedStrategyPnlUsdt: estimatedProfitUsdt,
        error: spotResult.error,
        code: spotResult.code,
      };
      await this.audit.log('error', 'spot_order_failed', {
        error: spotResult.error,
        code: spotResult.code,
        symbol,
      });
      const failId = createHash('sha256')
        .update(`${spotKey}-fail-${Date.now()}`)
        .digest('hex')
        .slice(0, 32);
      const failed = await this.prisma.orderIntent.create({
        data: {
          idempotencyKey: failId,
          provider: 'binance_spot',
          side: `SPOT_${side}_MARKET`,
          status: 'FAILED',
          payload: failPayload as object,
        },
      });
      return {
        ev,
        ok: true,
        dryRun: false,
        executionMode,
        order: failed,
        estimatedProfitUsdt,
        orderCreated: true,
      };
    }

    const execPayload: SpotLivePayload = {
      p2pSpreadContext,
      spot: spotMeta,
      exchangeResponse: spotResult.data,
      estimatedStrategyPnlUsdt: estimatedProfitUsdt,
    };

    const { record, created } = await this.orders.createIdempotent({
      idempotencyKey: spotKey,
      provider: 'binance_spot',
      side: `SPOT_${side}_MARKET`,
      status: 'EXECUTED',
      payload: execPayload as Record<string, unknown>,
    });

    await this.audit.log(
      created ? 'info' : 'info',
      created ? 'spot_order_recorded' : 'spot_order_idempotent_hit',
      {
        orderIntentId: record.id,
        idempotencyKey: spotKey,
        symbol,
        orderId: spotResult.data.orderId,
      },
    );

    return {
      ev,
      ok: true,
      dryRun: false,
      executionMode,
      order: record,
      estimatedProfitUsdt,
      orderCreated: created,
    };
  }

  /**
   * Сводка для Telegram: площадка, автоторговля, баланс/бумага, оценка «заработка», последние сделки.
   */
  async buildTelegramTradingReport(): Promise<string> {
    const dryRun = this.config.get<boolean>('dryRun') ?? true;
    const hasKeys = this.binanceSpot.spotExecutionAllowed();
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'BTCUSDT';
    const spotSide =
      this.config.get<'BUY' | 'SELL'>('binance.spotOrderSide') ?? 'BUY';
    const maxQuote = this.config.get<number>('binance.spotMaxQuoteUsdt') ?? 20;
    const intervalMs =
      this.config.get<number>('autoTrade.intervalMs') ?? 180_000;
    const fiat = this.config.get<string>('market.fiat') ?? 'RUB';
    const asset = this.config.get<string>('market.asset') ?? 'USDT';

    const st = await this.prisma.botState.findUnique({
      where: { id: 'default' },
    });
    const autoOn = st?.autoTradeEnabled ?? false;

    let venue: string;
    if (dryRun) {
      venue = [
        'Режим: бумага (DRY_RUN=true).',
        `Сигнал: спред P2P ${asset}/${fiat} → запись SIMULATED, Spot не вызывается.`,
      ].join('\n');
    } else if (hasKeys) {
      venue = [
        'Режим: Spot Binance (реальные средства, api.binance.com).',
        `Пара: ${symbol}, MARKET ${spotSide}, не больше ${maxQuote} USDT за ордер.`,
        `Сигнал стратегии: спред P2P ${asset}/${fiat} и риск-фильтр.`,
      ].join('\n');
    } else {
      venue = [
        'DRY_RUN=false, но ключи Spot не заданы: добавьте BINANCE_API_KEY и BINANCE_API_SECRET.',
      ].join('\n');
    }

    const lines: string[] = [
      '📍 Куда сейчас торгуем',
      venue,
      '',
      `⏱ Автоторговля: ${autoOn ? 'ВКЛ' : 'ВЫКЛ'} (тик каждые ${Math.round(intervalMs / 1000)} с)`,
      '',
    ];

    if (dryRun) {
      const dash = await this.getPaperDashboard();
      lines.push('💰 Бумажный баланс (не биржа)');
      lines.push(
        `Текущий: ${dash.currentPaperWalletUsdt} USDT (старт ${dash.startingPaperWalletUsdt})`,
      );
      lines.push('');
      lines.push('📈 Накопленная оценка по модели (сумма оценок за циклы)');
      lines.push(
        `Всего по оценкам: ${dash.totalEstimatedPnLUsdt} USDT (модель спреда, не гарантия прибыли).`,
      );
    } else {
      lines.push('💰 Баланс на бирже (Spot)');
      if (!hasKeys) {
        lines.push(
          'Нет ключей — задайте BINANCE_API_KEY и BINANCE_API_SECRET.',
        );
      } else {
        const bal = await this.binanceSpot.getAccountBalances();
        if (!bal.ok) {
          lines.push(`Не удалось загрузить: ${bal.error}`);
          if (
            bal.error.includes('recvWindow') ||
            bal.error.includes('Timestamp')
          ) {
            lines.push(
              '(Обычно это расхождение часов с Binance; в приложении время синхронизируется с api/v3/time. При повторе ошибки проверьте системные часы или WSL: `wsl --shutdown` и перезапуск.)',
            );
          } else if (
            bal.error.includes('Invalid API-key') ||
            bal.error.includes('permissions for action')
          ) {
            lines.push(
              '(Binance −2015: ключ/секрет, права (Reading + Spot), whitelist IP — или неверная база URL: ключи с testnet.binance.vision работают только с BINANCE_SPOT_BASE_URL=https://testnet.binance.vision; ключи с binance.com — с https://api.binance.com.)',
            );
          }
        } else {
          const u = bal.balances.find((b) => b.asset === 'USDT');
          const base = symbol.replace(/USDT$|BUSD$|FDUSD$/, '');
          const bBase = bal.balances.find((b) => b.asset === base);
          const usdtFree = u ? parseFloat(u.free) + parseFloat(u.locked) : 0;
          lines.push(
            `USDT всего: ${usdtFree.toFixed(4)} (free ${u?.free ?? '0'}, lock ${u?.locked ?? '0'})`,
          );
          if (bBase) {
            const q = parseFloat(bBase.free) + parseFloat(bBase.locked);
            lines.push(
              `${base} всего: ${q.toFixed(8)} (free ${bBase.free}, lock ${bBase.locked})`,
            );
          } else {
            lines.push(
              `${base}: на счёте нет (или 0 — не попало в выдачу балансов).`,
            );
          }
        }
      }
      lines.push('');
      const spotAgg = await this.aggregateSpotEstimatedPnl();
      lines.push('📈 Оценка сигнала по Spot-операциям (по модели P2P-спреда)');
      lines.push(
        `Сумма оценок: ${spotAgg.sum.toFixed(6)} USDT (${spotAgg.count} ордеров). Реализованный результат по Spot — после продажи базового актива.`,
      );
    }

    lines.push('');
    lines.push('📋 Последние операции');
    if (!dryRun) {
      lines.push(
        'Строки «P2P симуляция» — тики оценки спреда (не Spot). Реальные сделки Spot помечены «Spot …».',
      );
    }

    const recent = await this.prisma.orderIntent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 12,
    });

    if (recent.length === 0) {
      lines.push('Пока пусто.');
    } else {
      for (const r of recent) {
        lines.push(this.formatOperationLine(r));
      }
    }

    lines.push('');
    lines.push(
      'Оценки по спреду — упрощённая модель; детали исполнения Spot — в строках «Spot» выше.',
    );

    return lines.join('\n');
  }

  private async aggregateSpotEstimatedPnl(): Promise<{
    sum: number;
    count: number;
  }> {
    const rows = await this.prisma.orderIntent.findMany({
      where: { provider: 'binance_spot' },
      select: { payload: true },
    });
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      const p = r.payload as SpotLivePayload | null;
      const v = p?.estimatedStrategyPnlUsdt;
      if (v != null && !Number.isNaN(v)) {
        sum += v;
        count++;
      }
    }
    return { sum, count };
  }

  private formatOperationLine(r: {
    createdAt: Date;
    provider: string;
    side: string;
    status: string;
    payload: unknown;
  }): string {
    const t = r.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    if (r.provider === 'binance' && r.status === 'SIMULATED') {
      const p = r.payload as SimPayload | null;
      const est = p?.estimatedProfitUsdt;
      const net = p?.netSpreadPercent;
      const estStr =
        est == null
          ? '—'
          : `${est >= 0 ? '+' : ''}${est.toFixed(4)} USDT (оценка)`;
      const netStr = net == null ? '—' : `${net.toFixed(3)}%`;
      return `• ${t} | P2P симуляция | спред ${netStr} | ${estStr}`;
    }
    if (r.provider === 'binance_spot') {
      const p = r.payload as SpotLivePayload | null;
      const est = p?.estimatedStrategyPnlUsdt;
      const estStr =
        est == null
          ? '—'
          : `${est >= 0 ? '+' : ''}${est.toFixed(4)} USDT (оценка сигнала)`;
      if (r.status === 'FAILED') {
        return `• ${t} | Spot ❌ | ${p?.error ?? r.status} | ${estStr}`;
      }
      const ex = p?.exchangeResponse;
      let cost = '—';
      if (ex && typeof ex === 'object') {
        const q = ex['cummulativeQuoteQty'] ?? ex['cumQuote'];
        if (q != null && (typeof q === 'string' || typeof q === 'number')) {
          cost = `${q} USDT`;
        }
      }
      const sym = p?.spot?.symbol ?? '?';
      const sd = p?.spot?.side ?? '?';
      return `• ${t} | Spot ${sym} ${sd} ✅ | потрачено ~${cost} | ${estStr}`;
    }
    return `• ${t} | ${r.provider} ${r.status}`;
  }
}
