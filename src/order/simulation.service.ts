import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  BinanceSpotService,
  SpotMarketOrderResult,
} from '../binance/binance-spot.service';
import {
  applyBuyFill,
  applySellFill,
  balanceDivergenceBlocksRoundtrip,
  computePeakMarkPrice,
  computeSellQuantityRespectingMinNotional,
  effectiveTakeProfitPercent,
  priceHitsEmergencyDrawdown,
  priceHitsStopLoss,
  priceHitsTakeProfit,
  scaleQuoteByVolatility,
} from '../binance/spot-roundtrip.util';
import { windowHighForHours } from '../market/market-stats.util';
import { MarketStatsService } from '../market/market-stats.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrderIntentService } from './order-intent.service';
import { RiskService } from '../risk/risk.service';
import { SpreadService } from '../strategy/spread.service';
import { parseSpotExchangeFill } from './balance-telegram.format';

/** Поля в payload OrderIntent для бумажной статистики */
export type SimPayload = {
  grossSpreadPercent: number;
  netSpreadPercent: number;
  notionalUsdt: number;
  snapshot: { bestBuy: number | null; bestSell: number | null };
  /** Оценка: notional × чистый спред % / 100 (упрощённо, не гарантия прибыли). */
  estimatedProfitUsdt: number | null;
  /** Режим roundtrip (бумага): синтетическое исполнение по тикеру */
  roundtrip?: {
    markPrice: number;
    chosenSide: 'BUY' | 'SELL';
    trackedBtcAfter: number;
    avgEntryUsdtAfter: number;
    takeProfitPercent: number;
    /** Бумажная оценка при SELL */
    realizedPnlUsdtEstimate?: number | null;
    exitKind?: 'take_profit' | 'stop_loss' | 'emergency_drawdown';
  };
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
    baseAsset?: string;
    quoteAsset?: string;
  };
  exchangeResponse?: Record<string, unknown>;
  /** Оценка «сигнала» по P2P-спреду на объёме notional (не реализованный PnL Spot). */
  estimatedStrategyPnlUsdt?: number | null;
  /** Состояние roundtrip после сделки (и марк на момент решения). */
  roundtrip?: {
    trackedBtcAfter: number;
    avgEntryUsdtAfter: number;
    takeProfitPercent: number;
    markPrice: number;
    /** Оценка реализованного PnL по USDT (только SELL, упрощённо). */
    realizedPnlUsdtEstimate?: number | null;
    /** Почему закрыли позицию (только SELL). */
    exitKind?: 'take_profit' | 'stop_loss' | 'emergency_drawdown';
  };
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
    private readonly marketStats: MarketStatsService,
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
    const fiat = this.config.get<string>('market.fiat') ?? 'USD';
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
        ...(ev.snapshot.hint ? { p2pHint: ev.snapshot.hint } : {}),
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

    const spotStrategy =
      this.config.get<'fixed_side' | 'roundtrip'>('binance.spotStrategy') ??
      'fixed_side';
    if (spotStrategy === 'roundtrip') {
      return this.runRoundtripPairSimulation({
        notionalUsdt,
        ev,
        gross,
        net,
        estimatedProfitUsdt,
        idempotencyKey,
        dryRun,
        executionMode,
        asset,
        fiat,
      });
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
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const side =
      this.config.get<'BUY' | 'SELL'>('binance.spotOrderSide') ?? 'BUY';
    const maxQuoteUsdt =
      this.config.get<number>('binance.spotMaxQuoteUsdt') ?? 20;
    const maxQuoteRub =
      this.config.get<number>('binance.spotMaxQuoteRub') ?? 50_000;
    const spotQty = this.config.get<number>('binance.spotQuantity') ?? 0;

    const pairFil = await this.binanceSpot.getLotSizeFilter(symbol);
    if (!pairFil.ok) {
      await this.audit.log('error', 'spot_order_failed', {
        error: pairFil.error,
        symbol,
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
    const maxQuote = pairFil.quoteAsset === 'RUB' ? maxQuoteRub : maxQuoteUsdt;

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
      baseAsset: pairFil.baseAsset,
      quoteAsset: pairFil.quoteAsset,
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

    const spotKey = `spot-${side}-${idempotencyKey}`;

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

  private parseSpotOrderFill(data: Record<string, unknown>): {
    executedQty: number;
    cumQuote: number;
  } {
    const { baseQty, quoteQty } = parseSpotExchangeFill(data);
    return { executedQty: baseQty, cumQuote: quoteQty };
  }

  private async persistRoundtripState(
    trackedBtc: number,
    avgEntryUsdt: number,
    peakMarkUsdt: number,
    opts?: { recordSellCooldown?: boolean },
  ) {
    const t = Number(trackedBtc.toFixed(8));
    const a = Number(avgEntryUsdt.toFixed(8));
    const p = Number(peakMarkUsdt.toFixed(8));
    const recordSell = opts?.recordSellCooldown === true && t <= 1e-12;
    await this.prisma.botState.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        spotTrackedBtc: new Prisma.Decimal(String(t)),
        spotAvgEntryUsdt: new Prisma.Decimal(String(a)),
        spotRoundtripPeakMarkUsdt: new Prisma.Decimal(String(p)),
        spotRoundtripLastSellAt: recordSell ? new Date() : null,
      },
      update: {
        spotTrackedBtc: new Prisma.Decimal(String(t)),
        spotAvgEntryUsdt: new Prisma.Decimal(String(a)),
        spotRoundtripPeakMarkUsdt: new Prisma.Decimal(String(p)),
        ...(recordSell ? { spotRoundtripLastSellAt: new Date() } : {}),
      },
    });
  }

  /**
   * Spot roundtrip: при сигнале P2P — BUY до take-profit или SELL учётной позиции по марку.
   */
  private async runRoundtripPairSimulation(params: {
    notionalUsdt: number;
    ev: Awaited<ReturnType<SpreadService['evaluate']>>;
    gross: number;
    net: number;
    estimatedProfitUsdt: number | null;
    idempotencyKey: string;
    dryRun: boolean;
    executionMode: string | undefined;
    asset: string;
    fiat: string;
  }) {
    const {
      notionalUsdt,
      ev,
      gross,
      net,
      estimatedProfitUsdt,
      idempotencyKey,
      dryRun,
      executionMode,
    } = params;

    const spotBaseUrl =
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com';
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const maxQuoteUsdt =
      this.config.get<number>('binance.spotMaxQuoteUsdt') ?? 20;
    const maxQuoteRub =
      this.config.get<number>('binance.spotMaxQuoteRub') ?? 50_000;
    const tpPercent =
      this.config.get<number>('binance.roundtripTakeProfitPercent') ?? 0.15;
    const minTpPct =
      this.config.get<number>('binance.roundtripMinTakeProfitPercent') ?? 0;
    const assumedRoundtripFeePct =
      this.config.get<number>('binance.roundtripAssumedRoundtripFeePercent') ??
      0;
    const effectiveTpPercent = effectiveTakeProfitPercent({
      configuredPercent: tpPercent,
      minPercent: minTpPct,
      assumedRoundtripFeePercent: assumedRoundtripFeePct,
    });
    const slPercent =
      this.config.get<number>('binance.roundtripStopLossPercent') ?? 0;
    const maxPosUsdt =
      this.config.get<number>('binance.roundtripMaxPositionUsdt') ?? 0;
    const maxPosRub =
      this.config.get<number>('binance.roundtripMaxPositionRub') ?? 0;
    const accumulateOnSignal =
      this.config.get<boolean>('binance.roundtripAccumulateOnSignal') ?? false;

    const p2pSpreadContext = {
      grossSpreadPercent: gross,
      netSpreadPercent: net,
      notionalUsdt,
      bestBuy: ev.snapshot.bestBuyUsdtPrice,
      bestSell: ev.snapshot.bestSellUsdtPrice,
    };

    const tick = await this.binanceSpot.getTickerPrice(symbol);
    if (!tick.ok) {
      await this.audit.log('warn', 'roundtrip_skip', {
        reason: 'ticker_failed',
        error: tick.error,
        symbol,
      });
      return {
        ev,
        ok: true,
        dryRun,
        executionMode,
        order: null,
        estimatedProfitUsdt,
        orderCreated: false,
      };
    }
    const markPrice = tick.price;

    const symFil = await this.binanceSpot.getLotSizeFilter(symbol);
    if (!symFil.ok) {
      await this.audit.log('warn', 'roundtrip_skip', {
        reason: 'lot_filter_failed',
        error: symFil.error,
        symbol,
      });
      return {
        ev,
        ok: true,
        dryRun,
        executionMode,
        order: null,
        estimatedProfitUsdt,
        orderCreated: false,
      };
    }
    const baseAsset = symFil.baseAsset;
    const quoteAsset = symFil.quoteAsset;
    const maxQuote = quoteAsset === 'RUB' ? maxQuoteRub : maxQuoteUsdt;
    const maxPosQuote = quoteAsset === 'RUB' ? maxPosRub : maxPosUsdt;

    const st = await this.prisma.botState.findUnique({
      where: { id: 'default' },
    });
    const tracked = Number(st?.spotTrackedBtc ?? 0);
    const avgEntry = Number(st?.spotAvgEntryUsdt ?? 0);
    const prevPeak = Number(st?.spotRoundtripPeakMarkUsdt ?? 0);
    const peakMark = computePeakMarkPrice({
      trackedBtc: tracked,
      prevPeakMarkUsdt: prevPeak,
      markPrice,
    });

    const divMaxPct =
      this.config.get<number>('binance.roundtripBalanceDivergenceMaxPct') ?? 0;
    if (!dryRun && divMaxPct > 0 && tracked >= symFil.lot.minQty - 1e-12) {
      const balDiv = await this.binanceSpot.getAccountBalances();
      if (balDiv.ok) {
        const rowB = balDiv.balances.find((b) => b.asset === baseAsset);
        const freeB = rowB != null ? parseFloat(rowB.free) : 0;
        const { block, deviationPct: devPct } =
          balanceDivergenceBlocksRoundtrip({
            freeBase: freeB,
            trackedBase: tracked,
            maxDivergencePct: divMaxPct,
          });
        if (block) {
          await this.audit.log('warn', 'roundtrip_skip', {
            reason: 'balance_divergence',
            tracked,
            freeBase: freeB,
            deviationPct: devPct,
            maxAllowedPct: divMaxPct,
            baseAsset,
            symbol,
          });
          await this.persistRoundtripState(tracked, avgEntry, peakMark);
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }
    }

    const emPct =
      this.config.get<number>('binance.roundtripEmergencyDrawdownPercent') ?? 0;
    const emergencyHit =
      tracked > 0 &&
      emPct > 0 &&
      peakMark > 0 &&
      priceHitsEmergencyDrawdown({
        markPrice,
        peakMarkUsdt: peakMark,
        drawdownPercent: emPct,
      });

    const tpHit =
      tracked > 0 &&
      priceHitsTakeProfit({
        markPrice,
        avgEntryUsdt: avgEntry,
        takeProfitPercent: effectiveTpPercent,
      });
    const slHit =
      tracked > 0 &&
      slPercent > 0 &&
      priceHitsStopLoss({
        markPrice,
        avgEntryUsdt: avgEntry,
        stopLossPercent: slPercent,
      });
    const wantSell = tpHit || slHit || emergencyHit;
    const sellExitKind:
      | 'take_profit'
      | 'stop_loss'
      | 'emergency_drawdown'
      | null = slHit
      ? 'stop_loss'
      : emergencyHit
        ? 'emergency_drawdown'
        : tpHit
          ? 'take_profit'
          : null;

    let resolvedSide: 'BUY' | 'SELL';
    let quoteOrderQty: number | undefined;
    let sellQty: number | undefined;

    if (wantSell) {
      let freeBtc = tracked;
      if (!dryRun) {
        const bal = await this.binanceSpot.getAccountBalances();
        if (!bal.ok) {
          await this.audit.log('warn', 'roundtrip_skip', {
            reason: 'balance_failed',
            error: bal.error,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
        const row = bal.balances.find((b) => b.asset === baseAsset);
        freeBtc = row != null ? parseFloat(row.free) : 0;
      }
      const { quantity, skipReason, belowMinNotional } =
        computeSellQuantityRespectingMinNotional({
          freeBtc,
          trackedBtc: tracked,
          lot: symFil.lot,
          markPriceQuote: markPrice,
          minNotionalQuote: symFil.minNotionalQuote,
        });
      if (quantity <= 0) {
        if (belowMinNotional) {
          await this.audit.log('warn', 'roundtrip_dust_below_min_notional', {
            reason:
              'Учётная позиция меньше min notional Binance; учёт сброшен (актив на Spot не трогаем).',
            skipReason,
            tracked,
            avgEntryUsdt: avgEntry,
            markPrice,
            minNotionalQuote: symFil.minNotionalQuote,
            quoteAsset,
            symbol,
          });
          await this.persistRoundtripState(0, 0, 0);
        } else {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'sell_qty_unavailable',
            skipReason,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
        }
        return {
          ev,
          ok: true,
          dryRun,
          executionMode,
          order: null,
          estimatedProfitUsdt,
          orderCreated: false,
        };
      }
      resolvedSide = 'SELL';
      sellQty = quantity;
    } else if (!accumulateOnSignal && tracked > 0) {
      const tpThreshold = avgEntry * (1 + effectiveTpPercent / 100);
      const slThreshold =
        slPercent > 0 ? avgEntry * (1 - slPercent / 100) : null;
      await this.audit.log('info', 'roundtrip_skip', {
        reason: 'hold_until_tp_no_accumulate',
        tracked,
        avgEntryUsdt: avgEntry,
        markPrice,
        tpThresholdUsdt: tpThreshold,
        slThresholdUsdt: slThreshold,
        tpPercent: effectiveTpPercent,
        slPercent,
        peakMarkUsdt: peakMark,
        symbol,
      });
      await this.persistRoundtripState(tracked, avgEntry, peakMark);
      return {
        ev,
        ok: true,
        dryRun,
        executionMode,
        order: null,
        estimatedProfitUsdt,
        orderCreated: false,
      };
    } else {
      const cooldownMs =
        this.config.get<number>('binance.buyCooldownAfterSellMs') ?? 0;
      const lastSellAt = st?.spotRoundtripLastSellAt ?? null;
      if (
        cooldownMs > 0 &&
        lastSellAt != null &&
        Date.now() - lastSellAt.getTime() < cooldownMs
      ) {
        await this.audit.log('info', 'roundtrip_skip', {
          reason: 'skip_buy_cooldown_after_sell',
          cooldownMs,
          lastSellAt: lastSellAt.toISOString(),
          elapsedMs: Date.now() - lastSellAt.getTime(),
          symbol,
        });
        if (tracked > 0) {
          await this.persistRoundtripState(tracked, avgEntry, peakMark);
        }
        return {
          ev,
          ok: true,
          dryRun,
          executionMode,
          order: null,
          estimatedProfitUsdt,
          orderCreated: false,
        };
      }

      const skipVol =
        this.config.get<number>('binance.skipBuyVolatilityStdevGt') ?? 0;
      const skipCh24 =
        this.config.get<number>('binance.skipBuyChange24hGt') ?? 0;
      const volScaleOn =
        this.config.get<boolean>('binance.quoteVolatilityScaleEnabled') ??
        false;
      const refStd =
        this.config.get<number>('binance.quoteVolatilityRefStdevPp') ?? 0.2;
      const minScale =
        this.config.get<number>('binance.quoteVolatilityMinScale') ?? 0.25;

      const regimeReport = await this.marketStats.getReport(symbol);
      if (regimeReport && skipVol > 0) {
        const st24 = regimeReport.windows.h24.returnStdevPp;
        if (Number.isFinite(st24) && st24 > skipVol) {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'skip_buy_volatility',
            returnStdevPp: st24,
            threshold: skipVol,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }
      if (regimeReport && skipCh24 > 0) {
        const ch = regimeReport.windows.h24.changePct;
        if (Number.isFinite(ch) && ch > skipCh24) {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'skip_buy_change_24h',
            changePct24h: ch,
            threshold: skipCh24,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }

      const skipCh24Lt =
        this.config.get<number>('binance.skipBuyChange24hLt') ?? 0;
      if (regimeReport && skipCh24Lt < 0) {
        const chLo = regimeReport.windows.h24.changePct;
        if (Number.isFinite(chLo) && chLo < skipCh24Lt) {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'skip_buy_downtrend_24h',
            changePct24h: chLo,
            thresholdLt: skipCh24Lt,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }

      const skipCh168Lt =
        this.config.get<number>('binance.skipBuyChange168hLt') ?? 0;
      if (regimeReport && skipCh168Lt < 0) {
        const ch7 = regimeReport.windows.h168.changePct;
        if (Number.isFinite(ch7) && ch7 < skipCh168Lt) {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'skip_buy_downtrend_7d',
            changePct168h: ch7,
            thresholdLt: skipCh168Lt,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }

      const pullbackH =
        this.config.get<number>('binance.buyPullbackWindowHours') ?? 0;
      const minPullbackPct =
        this.config.get<number>('binance.buyMinPullbackFromHighPct') ?? 0;
      if (
        regimeReport &&
        pullbackH > 0 &&
        minPullbackPct > 0 &&
        regimeReport.windowHighs != null
      ) {
        const windowHigh = windowHighForHours(
          regimeReport.windowHighs,
          pullbackH,
        );
        if (
          Number.isFinite(windowHigh) &&
          windowHigh > 0 &&
          Number.isFinite(markPrice) &&
          markPrice > 0
        ) {
          const dropFromHighPct = ((windowHigh - markPrice) / windowHigh) * 100;
          if (dropFromHighPct + 1e-9 < minPullbackPct) {
            await this.audit.log('info', 'roundtrip_skip', {
              reason: 'skip_buy_near_window_high',
              pullbackWindowHours: pullbackH,
              windowHigh,
              markPrice,
              dropFromHighPct,
              minPullbackFromHighPct: minPullbackPct,
              symbol,
            });
            if (tracked > 0) {
              await this.persistRoundtripState(tracked, avgEntry, peakMark);
            }
            return {
              ev,
              ok: true,
              dryRun,
              executionMode,
              order: null,
              estimatedProfitUsdt,
              orderCreated: false,
            };
          }
        }
      }

      resolvedSide = 'BUY';
      let q = Math.min(notionalUsdt, maxQuote);
      if (regimeReport && volScaleOn) {
        q = scaleQuoteByVolatility({
          maxQuoteUsdt: q,
          returnStdevPp: regimeReport.windows.h24.returnStdevPp,
          refStdevPp: refStd,
          minScale,
          enabled: true,
        });
      }
      quoteOrderQty = q;
      if (maxPosQuote > 0) {
        const posVal = tracked * avgEntry;
        if (posVal + (quoteOrderQty ?? 0) > maxPosQuote) {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'max_position_quote',
            maxPosQuote,
            quoteAsset,
            positionValueQuote: posVal,
            quoteOrderQty,
            tracked,
            avgEntryUsdt: avgEntry,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }
      if (!dryRun) {
        const balU = await this.binanceSpot.getAccountBalances();
        if (!balU.ok) {
          await this.audit.log('warn', 'roundtrip_skip', {
            reason: 'balance_failed',
            error: balU.error,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
        const quoteRow = balU.balances.find((b) => b.asset === quoteAsset);
        const freeQuote = quoteRow != null ? parseFloat(quoteRow.free) : 0;
        if (freeQuote < (quoteOrderQty ?? 0)) {
          await this.audit.log('warn', 'roundtrip_skip', {
            reason: 'insufficient_quote',
            quoteAsset,
            freeQuote,
            needQuote: quoteOrderQty,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            dryRun,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }
    }

    const spotKey = `spot-${resolvedSide}-${idempotencyKey}`;

    const spotMeta = {
      baseUrl: spotBaseUrl,
      symbol,
      side: resolvedSide,
      baseAsset,
      quoteAsset,
      ...(resolvedSide === 'BUY'
        ? { quoteOrderQty: quoteOrderQty as number }
        : { quantity: sellQty as number }),
    };

    if (dryRun) {
      const quote = quoteOrderQty ?? 0;
      let trackedAfter = tracked;
      let avgAfter = avgEntry;
      let realizedEst: number | null = null;

      if (resolvedSide === 'BUY') {
        const execBtc = quote / markPrice;
        const fill = applyBuyFill({
          trackedBtc: tracked,
          avgEntryUsdt: avgEntry,
          executedBtc: execBtc,
          quoteUsdtSpent: quote,
        });
        trackedAfter = fill.trackedBtc;
        avgAfter = fill.avgEntryUsdt;
      } else {
        const qty = sellQty ?? 0;
        const received = qty * markPrice;
        const costBasis = qty * avgEntry;
        realizedEst = received - costBasis;
        const fill = applySellFill({
          trackedBtc: tracked,
          avgEntryUsdt: avgEntry,
          soldBtc: qty,
        });
        trackedAfter = fill.trackedBtc;
        avgAfter = fill.avgEntryUsdt;
      }

      const peakAfter = trackedAfter > 0 ? Math.max(peakMark, markPrice) : 0;
      await this.persistRoundtripState(trackedAfter, avgAfter, peakAfter, {
        recordSellCooldown: resolvedSide === 'SELL',
      });

      const payload: SimPayload = {
        grossSpreadPercent: gross,
        netSpreadPercent: net,
        notionalUsdt,
        snapshot: {
          bestBuy: ev.snapshot.bestBuyUsdtPrice,
          bestSell: ev.snapshot.bestSellUsdtPrice,
        },
        estimatedProfitUsdt,
        roundtrip: {
          markPrice,
          chosenSide: resolvedSide,
          trackedBtcAfter: trackedAfter,
          avgEntryUsdtAfter: avgAfter,
          takeProfitPercent: effectiveTpPercent,
          ...(resolvedSide === 'SELL'
            ? {
                realizedPnlUsdtEstimate: realizedEst,
                exitKind: sellExitKind ?? undefined,
              }
            : {}),
        },
      };

      const { record, created } = await this.orders.createIdempotent({
        idempotencyKey: spotKey,
        provider: 'binance',
        side: 'P2P_SPREAD_SIM',
        status: 'SIMULATED',
        payload,
      });

      await this.audit.log(
        'info',
        created
          ? 'roundtrip_simulation_recorded'
          : 'roundtrip_simulation_idempotent',
        {
          orderIntentId: record.id,
          idempotencyKey: spotKey,
          side: resolvedSide,
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
      if (tracked > 0) {
        await this.persistRoundtripState(tracked, avgEntry, peakMark);
      }
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

    let spotResult: SpotMarketOrderResult;
    if (resolvedSide === 'BUY') {
      spotResult = await this.binanceSpot.placeMarketOrder({
        symbol,
        side: 'BUY',
        quoteOrderQty: quoteOrderQty as number,
      });
    } else {
      spotResult = await this.binanceSpot.placeMarketOrder({
        symbol,
        side: 'SELL',
        quantity: sellQty as number,
      });
    }

    if (!spotResult.ok) {
      const notionalDustSell =
        resolvedSide === 'SELL' &&
        wantSell &&
        spotResult.code === -1013 &&
        String(spotResult.error ?? '')
          .toLowerCase()
          .includes('notional');
      const failPayload: SpotLivePayload = {
        p2pSpreadContext,
        spot: spotMeta,
        estimatedStrategyPnlUsdt: estimatedProfitUsdt,
        error: spotResult.error,
        code: spotResult.code,
      };
      if (notionalDustSell) {
        await this.audit.log('warn', 'roundtrip_dust_exchange_notional', {
          message:
            'Binance отклонил SELL (NOTIONAL): сброс учётной позиции; пыль остаётся на Spot.',
          error: spotResult.error,
          tracked,
          symbol,
        });
        await this.persistRoundtripState(0, 0, 0);
      } else {
        await this.audit.log('error', 'spot_order_failed', {
          error: spotResult.error,
          code: spotResult.code,
          symbol,
        });
        if (tracked > 0) {
          await this.persistRoundtripState(tracked, avgEntry, peakMark);
        }
      }
      const failId = createHash('sha256')
        .update(`${spotKey}-fail-${Date.now()}`)
        .digest('hex')
        .slice(0, 32);
      const failed = await this.prisma.orderIntent.create({
        data: {
          idempotencyKey: failId,
          provider: 'binance_spot',
          side: `SPOT_${resolvedSide}_MARKET`,
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

    const exData = spotResult.data;
    const { executedQty, cumQuote } = this.parseSpotOrderFill(exData);
    let trackedAfter = tracked;
    let avgAfter = avgEntry;
    let realizedEst: number | null = null;

    if (resolvedSide === 'BUY') {
      const fill = applyBuyFill({
        trackedBtc: tracked,
        avgEntryUsdt: avgEntry,
        executedBtc: executedQty,
        quoteUsdtSpent: cumQuote,
      });
      trackedAfter = fill.trackedBtc;
      avgAfter = fill.avgEntryUsdt;
    } else {
      const received = cumQuote;
      const costBasis = executedQty * avgEntry;
      realizedEst = received - costBasis;
      const fill = applySellFill({
        trackedBtc: tracked,
        avgEntryUsdt: avgEntry,
        soldBtc: executedQty,
      });
      trackedAfter = fill.trackedBtc;
      avgAfter = fill.avgEntryUsdt;
    }

    const peakAfterLive = trackedAfter > 0 ? Math.max(peakMark, markPrice) : 0;
    await this.persistRoundtripState(trackedAfter, avgAfter, peakAfterLive, {
      recordSellCooldown: resolvedSide === 'SELL',
    });

    const execPayload: SpotLivePayload = {
      p2pSpreadContext,
      spot: spotMeta,
      exchangeResponse: exData,
      estimatedStrategyPnlUsdt: estimatedProfitUsdt,
      roundtrip: {
        trackedBtcAfter: trackedAfter,
        avgEntryUsdtAfter: avgAfter,
        takeProfitPercent: effectiveTpPercent,
        markPrice,
        realizedPnlUsdtEstimate:
          resolvedSide === 'SELL' ? realizedEst : undefined,
        exitKind:
          resolvedSide === 'SELL' && sellExitKind ? sellExitKind : undefined,
      },
    };

    const { record, created } = await this.orders.createIdempotent({
      idempotencyKey: spotKey,
      provider: 'binance_spot',
      side: `SPOT_${resolvedSide}_MARKET`,
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
        orderId: exData['orderId'],
        side: resolvedSide,
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
   * Краткая сводка для Telegram: баланс, сделки, прибыль по продажам.
   */
  async buildTelegramTradingReport(): Promise<string> {
    const dryRun = this.config.get<boolean>('dryRun') ?? true;
    const hasKeys = this.binanceSpot.spotExecutionAllowed();
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const pairFil = await this.binanceSpot.getLotSizeFilter(symbol);
    const baseAsset = pairFil.ok
      ? pairFil.baseAsset
      : symbol.replace(/USDT$|BUSD$|FDUSD$/, '') || 'SOL';
    const quoteAsset = pairFil.ok ? pairFil.quoteAsset : 'USDT';
    const maxQuoteUsdt =
      this.config.get<number>('binance.spotMaxQuoteUsdt') ?? 20;
    const maxQuoteRub =
      this.config.get<number>('binance.spotMaxQuoteRub') ?? 50_000;
    const maxQuote = quoteAsset === 'RUB' ? maxQuoteRub : maxQuoteUsdt;
    const maxPosUsdt =
      this.config.get<number>('binance.roundtripMaxPositionUsdt') ?? 0;
    const maxPosRub =
      this.config.get<number>('binance.roundtripMaxPositionRub') ?? 0;
    const maxPosRoundtrip = quoteAsset === 'RUB' ? maxPosRub : maxPosUsdt;
    const spotStrategy =
      this.config.get<'fixed_side' | 'roundtrip'>('binance.spotStrategy') ??
      'fixed_side';
    const spotSide =
      this.config.get<'BUY' | 'SELL'>('binance.spotOrderSide') ?? 'BUY';
    const tpPct =
      this.config.get<number>('binance.roundtripTakeProfitPercent') ?? 0.15;
    const minTpPct =
      this.config.get<number>('binance.roundtripMinTakeProfitPercent') ?? 0;
    const assumedFeePct =
      this.config.get<number>('binance.roundtripAssumedRoundtripFeePercent') ??
      0;
    const effectiveTpPct = effectiveTakeProfitPercent({
      configuredPercent: tpPct,
      minPercent: minTpPct,
      assumedRoundtripFeePercent: assumedFeePct,
    });
    const slPct =
      this.config.get<number>('binance.roundtripStopLossPercent') ?? 0;
    const rtAccumulate =
      this.config.get<boolean>('binance.roundtripAccumulateOnSignal') ?? false;
    const fiat = this.config.get<string>('market.fiat') ?? 'USD';
    const asset = this.config.get<string>('market.asset') ?? 'USDT';
    const equityBaseline =
      this.config.get<number | null>('stats.equityBaselineQuote') ?? null;

    const st = await this.prisma.botState.findUnique({
      where: { id: 'default' },
    });

    const fmtQ = (n: number, fd = 4) =>
      n.toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: fd,
      });

    const lines: string[] = ['📊 Сводка', ''];

    if (dryRun) {
      const dash = await this.getPaperDashboard();
      lines.push('🧪 Бумажный режим (без Spot).');
      lines.push(
        `💼 Вирт. кошелёк: ${fmtQ(dash.currentPaperWalletUsdt)} USDT (старт ${fmtQ(dash.startingPaperWalletUsdt)})`,
      );
      lines.push(
        `📋 Тест-сделок в БД: ${dash.totalSimulatedTrades}; сумма оценок: ${fmtQ(dash.totalEstimatedPnLUsdt)} USDT`,
      );
    } else if (!hasKeys) {
      lines.push('⚠️ Ключи API не заданы — баланс биржи недоступен.');
    } else {
      const bal = await this.binanceSpot.getAccountBalances();
      if (!bal.ok) {
        lines.push(`⚠️ Баланс: ${bal.error}`);
      } else {
        const qRow = bal.balances.find((b) => b.asset === quoteAsset);
        const bRow = bal.balances.find((b) => b.asset === baseAsset);
        const uf = qRow ? parseFloat(qRow.free) : 0;
        const ul = qRow ? parseFloat(qRow.locked) : 0;
        const bf = bRow ? parseFloat(bRow.free) : 0;
        const bl = bRow ? parseFloat(bRow.locked) : 0;
        const quoteTot = uf + ul;
        const baseTot = bf + bl;

        const tick = await this.binanceSpot.getTickerPrice(symbol);
        const mark = tick.ok ? tick.price : NaN;
        const equity =
          Number.isFinite(mark) && mark > 0 ? quoteTot + baseTot * mark : NaN;

        lines.push(
          `💵 ${quoteAsset}: ${fmtQ(quoteTot)} · ${baseAsset}: ${fmtQ(baseTot, 8)}`,
        );
        if (Number.isFinite(equity)) {
          lines.push(
            `💰 Оценка счёта в ${quoteAsset}: ~${fmtQ(equity)} (котировка + база × марк)`,
          );
          if (equityBaseline != null && equityBaseline > 0) {
            const diff = equity - equityBaseline;
            const pct = (diff / equityBaseline) * 100;
            const sign = diff >= 0 ? '📈' : '📉';
            lines.push(
              `${sign} К старту (${fmtQ(equityBaseline)} ${quoteAsset}): ${diff >= 0 ? '+' : ''}${fmtQ(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
            );
          }
        } else {
          lines.push('📍 Марк недоступен — полную оценку счёта не посчитать.');
        }
      }
      lines.push('');

      const tracked =
        st?.spotTrackedBtc != null ? Number(st.spotTrackedBtc) : 0;
      const avgE =
        st?.spotAvgEntryUsdt != null ? Number(st.spotAvgEntryUsdt) : 0;

      if (spotStrategy === 'roundtrip') {
        const emPctRt =
          this.config.get<number>(
            'binance.roundtripEmergencyDrawdownPercent',
          ) ?? 0;
        const peak =
          st?.spotRoundtripPeakMarkUsdt != null
            ? Number(st.spotRoundtripPeakMarkUsdt)
            : 0;

        const stratBits: string[] = [
          `тейк +${effectiveTpPct}% к средней`,
          `ордер до ${maxQuote} ${quoteAsset}`,
        ];
        if (slPct > 0) stratBits.push(`стоп −${slPct}%`);
        if (maxPosRoundtrip > 0)
          stratBits.push(`лимит поз. ~${maxPosRoundtrip} ${quoteAsset}`);
        if (rtAccumulate) stratBits.push('докупки по сигналу');
        lines.push(`⚙️ Roundtrip: ${stratBits.join(' · ')}`);
        lines.push('');

        const tick2 = await this.binanceSpot.getTickerPrice(symbol);
        if (tick2.ok && tracked > 0 && avgE > 0) {
          const m = tick2.price;
          const tpTh = avgE * (1 + effectiveTpPct / 100);
          const unreal = tracked * (m - avgE);
          const unrealPct = ((m - avgE) / avgE) * 100;
          const uEmoji = unreal >= 0 ? '✅' : '🔻';
          lines.push(`🎯 Позиция в ${baseAsset}`);
          lines.push(
            `   • В учёте: ${tracked.toFixed(8)} · средняя ${fmtQ(avgE, 2)} ${quoteAsset} за 1 ${baseAsset}`,
          );
          lines.push(
            `   • Марк: ~${fmtQ(m, 2)} ${quoteAsset} · нереализ. ${uEmoji} ${unreal >= 0 ? '+' : ''}${fmtQ(unreal)} (${unrealPct >= 0 ? '+' : ''}${unrealPct.toFixed(2)}%)`,
          );
          lines.push(
            `   • План продажи (тейк): выше ${fmtQ(tpTh, 2)} ${quoteAsset}`,
          );
          if (slPct > 0) {
            const slTh = avgE * (1 - slPct / 100);
            lines.push(`   • Стоп: ниже ${fmtQ(slTh, 2)} ${quoteAsset}`);
          }
          if (emPctRt > 0 && peak > 0) {
            lines.push(
              `   • Пик марка: ~${fmtQ(peak, 2)} · аварийный выход при −${emPctRt}% от пика`,
            );
          }
          const distTpPct = ((tpTh - m) / m) * 100;
          if (distTpPct > 0) {
            lines.push(
              `   • До тейка: ещё ~${distTpPct.toFixed(2)}% роста от марка`,
            );
          }
        } else if (tracked <= 0) {
          lines.push(`📭 Открытой учётной позиции нет.`);
        }
        lines.push('');
      } else {
        lines.push(
          `⚙️ Стратегия: ${spotSide}, до ${maxQuote} ${quoteAsset} за ордер`,
        );
        lines.push('');
      }

      const lastBuy = await this.getLastExecutedSpotBuy();
      if (lastBuy) {
        const t = lastBuy.createdAt
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ');
        lines.push('🛒 Последняя покупка на бирже');
        lines.push(
          `   • ${t} — ${lastBuy.baseQty.toFixed(8)} ${baseAsset} по ~${fmtQ(lastBuy.avgPrice, 2)} ${quoteAsset} (всего ${fmtQ(lastBuy.quoteQty)} ${quoteAsset})`,
        );
        if (spotStrategy === 'roundtrip') {
          const refAvg = avgE > 0 ? avgE : lastBuy.avgPrice;
          if (refAvg > 0) {
            const tpTh = refAvg * (1 + effectiveTpPct / 100);
            lines.push(
              `   • Цель (тейк): > ${fmtQ(tpTh, 2)} ${quoteAsset} за 1 ${baseAsset}`,
            );
          }
        }
        lines.push('');
      }
      lines.push(`🔗 Сигнал P2P: ${asset}/${fiat} при достаточном спреде`);
      lines.push('');
      const agg = await this.aggregateSpotExecStats();
      lines.push('📑 Исполненные ордера Spot');
      lines.push(
        `   Покупок: ${agg.buyCount} (~${fmtQ(agg.buyUsdt)} ${quoteAsset}) · Продаж: ${agg.sellCount} (~${fmtQ(agg.sellUsdt)})`,
      );
      if (agg.sellCount > 0) {
        const p = agg.profitFromSellsUsdt;
        lines.push(
          `   Реализованный P/L по продажам: ${p >= 0 ? '+' : ''}${fmtQ(p)} ${quoteAsset}`,
        );
      }
    }

    lines.push('');
    lines.push('📜 Последние операции:');

    const recent = await this.prisma.orderIntent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    if (recent.length === 0) {
      lines.push('— пока нет записей.');
    } else {
      for (const r of recent) {
        lines.push(this.formatOperationLine(r, baseAsset));
      }
    }

    return lines.join('\n');
  }

  /** Последний исполненный MARKET BUY по Spot (для /stats). */
  private async getLastExecutedSpotBuy(): Promise<{
    createdAt: Date;
    baseQty: number;
    quoteQty: number;
    avgPrice: number;
  } | null> {
    const rows = await this.prisma.orderIntent.findMany({
      where: { provider: 'binance_spot', status: 'EXECUTED' },
      orderBy: { createdAt: 'desc' },
      take: 48,
      select: { createdAt: true, payload: true },
    });
    for (const r of rows) {
      const p = r.payload as SpotLivePayload | null;
      if (p?.spot?.side !== 'BUY' || !p.exchangeResponse) continue;
      const { baseQty, quoteQty } = parseSpotExchangeFill(p.exchangeResponse);
      if (
        !Number.isFinite(baseQty) ||
        baseQty <= 0 ||
        !Number.isFinite(quoteQty)
      )
        continue;
      return {
        createdAt: r.createdAt,
        baseQty,
        quoteQty,
        avgPrice: quoteQty / baseQty,
      };
    }
    return null;
  }

  private async aggregateSpotExecStats(): Promise<{
    buyCount: number;
    sellCount: number;
    buyUsdt: number;
    sellUsdt: number;
    profitFromSellsUsdt: number;
  }> {
    const rows = await this.prisma.orderIntent.findMany({
      where: { provider: 'binance_spot', status: 'EXECUTED' },
      select: { payload: true },
    });
    let buyCount = 0;
    let sellCount = 0;
    let buyUsdt = 0;
    let sellUsdt = 0;
    let profitFromSellsUsdt = 0;
    for (const r of rows) {
      const p = r.payload as SpotLivePayload | null;
      if (!p?.spot?.side || !p.exchangeResponse) continue;
      const { quoteQty } = parseSpotExchangeFill(p.exchangeResponse);
      if (!Number.isFinite(quoteQty)) continue;
      if (p.spot.side === 'BUY') {
        buyCount++;
        buyUsdt += quoteQty;
      } else if (p.spot.side === 'SELL') {
        sellCount++;
        sellUsdt += quoteQty;
        const rp = p.roundtrip?.realizedPnlUsdtEstimate;
        if (rp != null && Number.isFinite(rp)) profitFromSellsUsdt += rp;
      }
    }
    return {
      buyCount,
      sellCount,
      buyUsdt,
      sellUsdt,
      profitFromSellsUsdt,
    };
  }

  private formatOperationLine(
    r: {
      createdAt: Date;
      provider: string;
      side: string;
      status: string;
      payload: unknown;
    },
    baseAsset: string,
  ): string {
    const t = r.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    if (r.provider === 'binance' && r.status === 'SIMULATED') {
      const p = r.payload as SimPayload | null;
      const rt = p?.roundtrip;
      if (rt) {
        const sideRu = rt.chosenSide === 'BUY' ? 'купил бы' : 'продал бы';
        return `• ${t} | Тест (без биржи): ${sideRu} по ~${rt.markPrice.toFixed(2)} (котировка/база) за 1 ${baseAsset}, в учёте после шага ${rt.trackedBtcAfter.toFixed(8)} ${baseAsset}`;
      }
      return `• ${t} | Тест (без биржи): сигнал, в расчёте ~${p?.notionalUsdt ?? '—'} USDT`;
    }
    if (r.provider === 'binance_spot') {
      const p = r.payload as SpotLivePayload | null;
      if (r.status === 'FAILED') {
        return `• ${t} | Ошибка: ${p?.error ?? r.status}`;
      }
      const ex = p?.exchangeResponse;
      const { baseQty, quoteQty } = parseSpotExchangeFill(ex);
      const qa = p?.spot?.quoteAsset ?? 'USDT';
      const sd = p?.spot?.side;
      const rtp = p?.roundtrip?.realizedPnlUsdtEstimate;
      if (
        sd === 'BUY' &&
        Number.isFinite(quoteQty) &&
        Number.isFinite(baseQty)
      ) {
        return `• ${t} | Купил ${baseQty.toFixed(8)} ${baseAsset} за ${quoteQty.toFixed(4)} ${qa}`;
      }
      if (
        sd === 'SELL' &&
        Number.isFinite(quoteQty) &&
        Number.isFinite(baseQty)
      ) {
        const ek = p?.roundtrip?.exitKind;
        const tag =
          ek === 'stop_loss'
            ? ' [стоп]'
            : ek === 'emergency_drawdown'
              ? ' [аварийно]'
              : ek === 'take_profit'
                ? ' [тейк]'
                : '';
        let tail = '';
        if (rtp != null && Number.isFinite(rtp)) {
          const cost = quoteQty - rtp;
          const pct = cost > 0 ? ((rtp / cost) * 100).toFixed(2) : '—';
          tail = `; прибыль ${rtp >= 0 ? '+' : ''}${rtp.toFixed(4)} ${qa} (~${pct}% к себестоимости)`;
        }
        return `• ${t} | Продал ${baseQty.toFixed(8)} ${baseAsset}, получил ${quoteQty.toFixed(4)} ${qa}${tag}${tail}`;
      }
      return `• ${t} | ${sd ?? '?'} ${p?.spot?.symbol ?? ''} (детали не распарсились)`;
    }
    return `• ${t} | ${r.provider} ${r.status}`;
  }
}
