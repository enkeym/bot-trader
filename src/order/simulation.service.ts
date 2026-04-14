import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  BinanceSpotService,
  SpotMarketOrderResult,
  SpotTicker24hrResult,
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
import {
  buildTelegramStatsHistoryBlocks,
  fmtStatsNumber,
  fmtStatsQtyBase,
  fmtUptimeProcess,
  pctArrow,
  TelegramStatsHistoryRow,
  telegramStatsBoxBlank,
  telegramStatsBoxBottom,
  telegramStatsBoxTop,
  telegramStatsInnerHr,
  telegramStatsLine,
} from './telegram-trading-report.format';

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

  async runPairSimulation(notionalUsdt: number) {
    const asset = this.config.get<string>('market.asset') ?? 'USDT';
    const fiat = this.config.get<string>('market.fiat') ?? 'USD';

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
        executionMode,
        asset,
        fiat,
      });
    }

    if (!this.binanceSpot.spotExecutionAllowed()) {
      await this.audit.log('warn', 'spot_execution_blocked', {
        message:
          'Для Spot укажите BINANCE_API_KEY и BINANCE_API_SECRET (ключи с binance.com → API Management).',
      });
      return {
        ev,
        ok: true,
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

  /** Exit kind последней исполненной SELL (для адаптивного cooldown). */
  private async getLastSellExitKind(): Promise<string | null> {
    const row = await this.prisma.orderIntent.findFirst({
      where: {
        provider: 'binance_spot',
        status: 'EXECUTED',
        side: { contains: 'SELL' },
      },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    if (!row) return null;
    const p = row.payload as SpotLivePayload | null;
    return p?.roundtrip?.exitKind ?? null;
  }

  /** Число последних подряд убыточных SELL (для адаптивного размера позиции). */
  private async countRecentConsecutiveLosses(): Promise<number> {
    const rows = await this.prisma.orderIntent.findMany({
      where: {
        provider: 'binance_spot',
        status: 'EXECUTED',
        side: { contains: 'SELL' },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { payload: true },
    });
    let count = 0;
    for (const row of rows) {
      const p = row.payload as SpotLivePayload | null;
      const est = p?.roundtrip?.realizedPnlUsdtEstimate;
      if (est == null || typeof est !== 'number' || est >= 0) break;
      count++;
    }
    return count;
  }

  /**
   * Комплексный сигнал входа в рынок. Взвешенная оценка 0-100.
   * - Тренд 24h (30): >0 бычий, -3..0 нейтральный, <-3 медвежий
   * - Тренд 7d (20): >0 бычий, -8..0 нейтральный, <-8 медвежий
   * - Волатильность (25): <0.2 низкая (хорошо), 0.2-0.35 средняя, >0.35 высокая
   * - Win rate последних 20 сделок (25): >60% хорошо, 40-60% нейтрально, <40% плохо
   */
  async computeMarketEntrySignal(): Promise<{
    score: number;
    verdict: 'DA' | 'OSTOROZHNO' | 'NET';
    trend24h: { changePct: number; label: string };
    trend7d: { changePct: number; label: string };
    volatility: { stdev: number; label: string };
    winRate: { rate: number; wins: number; total: number };
  }> {
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const report = await this.marketStats.getReport(symbol);

    const ch24 = report?.windows.h24.changePct ?? 0;
    const ch7d = report?.windows.h168.changePct ?? 0;
    const stdev24 = report?.windows.h24.returnStdevPp ?? 0.25;

    let trendScore24 = 50;
    if (ch24 > 0) trendScore24 = Math.min(100, 60 + ch24 * 10);
    else if (ch24 >= -3) trendScore24 = 40 + ((ch24 + 3) / 3) * 20;
    else trendScore24 = Math.max(0, 40 + ch24 * 5);

    let trendScore7d = 50;
    if (ch7d > 0) trendScore7d = Math.min(100, 55 + ch7d * 3);
    else if (ch7d >= -8) trendScore7d = 35 + ((ch7d + 8) / 8) * 20;
    else trendScore7d = Math.max(0, 35 + ch7d * 3);

    let volScore = 50;
    if (stdev24 < 0.2) volScore = Math.min(100, 70 + (0.2 - stdev24) * 200);
    else if (stdev24 <= 0.35) volScore = 70 - ((stdev24 - 0.2) / 0.15) * 40;
    else volScore = Math.max(0, 30 - (stdev24 - 0.35) * 100);

    const sells = await this.prisma.orderIntent.findMany({
      where: {
        provider: 'binance_spot',
        status: 'EXECUTED',
        side: { contains: 'SELL' },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { payload: true },
    });
    let wins = 0;
    for (const s of sells) {
      const est = (s.payload as SpotLivePayload | null)?.roundtrip
        ?.realizedPnlUsdtEstimate;
      if (est != null && typeof est === 'number' && est > 0) wins++;
    }
    const total = sells.length;
    const winRatePct = total > 0 ? (wins / total) * 100 : 50;

    let wrScore = 50;
    if (winRatePct > 60) wrScore = Math.min(100, 60 + (winRatePct - 60) * 2);
    else if (winRatePct >= 40) wrScore = 30 + ((winRatePct - 40) / 20) * 30;
    else wrScore = Math.max(0, winRatePct * 0.75);

    const score = Math.round(
      trendScore24 * 0.3 +
        trendScore7d * 0.2 +
        volScore * 0.25 +
        wrScore * 0.25,
    );

    const trendLabel = (ch: number, lo: number) =>
      ch > 0 ? 'бычий' : ch >= lo ? 'нейтральный' : 'медвежий';
    const volLabel =
      stdev24 < 0.2 ? 'низкая' : stdev24 <= 0.35 ? 'средняя' : 'высокая';

    const verdict: 'DA' | 'OSTOROZHNO' | 'NET' =
      score >= 60 ? 'DA' : score >= 40 ? 'OSTOROZHNO' : 'NET';

    return {
      score,
      verdict,
      trend24h: { changePct: ch24, label: trendLabel(ch24, -3) },
      trend7d: { changePct: ch7d, label: trendLabel(ch7d, -8) },
      volatility: { stdev: stdev24, label: volLabel },
      winRate: { rate: winRatePct, wins, total },
    };
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
    if (divMaxPct > 0 && tracked >= symFil.lot.minQty - 1e-12) {
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
          executionMode,
          order: null,
          estimatedProfitUsdt,
          orderCreated: false,
        };
      }
      const row = bal.balances.find((b) => b.asset === baseAsset);
      freeBtc = row != null ? parseFloat(row.free) : 0;
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
        executionMode,
        order: null,
        estimatedProfitUsdt,
        orderCreated: false,
      };
    } else {
      const baseCooldownMs =
        this.config.get<number>('binance.buyCooldownAfterSellMs') ?? 0;
      const lastSellAt = st?.spotRoundtripLastSellAt ?? null;
      if (baseCooldownMs > 0 && lastSellAt != null) {
        const lastExitKind = await this.getLastSellExitKind();
        const cooldownMs =
          lastExitKind === 'stop_loss' || lastExitKind === 'emergency_drawdown'
            ? baseCooldownMs * 2
            : baseCooldownMs;
        if (Date.now() - lastSellAt.getTime() < cooldownMs) {
          await this.audit.log('info', 'roundtrip_skip', {
            reason: 'skip_buy_cooldown_after_sell',
            cooldownMs,
            lastExitKind,
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
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }

      const regimeReport = await this.marketStats.getReport(symbol);

      const crashHaltPct =
        this.config.get<number>('binance.crashHaltChange24hPct') ?? 0;
      const crashReducePct =
        this.config.get<number>('binance.crashReduceChange24hPct') ?? 0;
      let crashSizeMultiplier = 1;
      if (regimeReport && crashHaltPct < 0) {
        const ch24 = regimeReport.windows.h24.changePct;
        if (Number.isFinite(ch24) && ch24 <= crashHaltPct) {
          await this.audit.log('warn', 'roundtrip_skip', {
            reason: 'crash_halt',
            changePct24h: ch24,
            threshold: crashHaltPct,
            symbol,
          });
          if (tracked > 0) {
            await this.persistRoundtripState(tracked, avgEntry, peakMark);
          }
          return {
            ev,
            ok: true,
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
        if (
          crashReducePct < 0 &&
          Number.isFinite(ch24) &&
          ch24 <= crashReducePct
        ) {
          crashSizeMultiplier = 0.5;
          void this.audit.log('info', 'roundtrip_crash_reduce', {
            changePct24h: ch24,
            threshold: crashReducePct,
            sizeMultiplier: 0.5,
            symbol,
          });
        }
      }

      const entrySignal = await this.computeMarketEntrySignal();
      if (entrySignal.score < 40) {
        await this.audit.log('info', 'roundtrip_skip', {
          reason: 'market_signal_negative',
          score: entrySignal.score,
          verdict: entrySignal.verdict,
          symbol,
        });
        if (tracked > 0) {
          await this.persistRoundtripState(tracked, avgEntry, peakMark);
        }
        return {
          ev,
          ok: true,
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
      const recentLossCount = await this.countRecentConsecutiveLosses();
      const adaptiveSizeMultiplier = 1 + Math.min(recentLossCount, 2) * 0.125;
      q = Math.min(q * adaptiveSizeMultiplier * crashSizeMultiplier, maxQuote);
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
            executionMode,
            order: null,
            estimatedProfitUsdt,
            orderCreated: false,
          };
        }
      }
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
          executionMode,
          order: null,
          estimatedProfitUsdt,
          orderCreated: false,
        };
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
      executionMode,
      order: record,
      estimatedProfitUsdt,
      orderCreated: created,
    };
  }

  /**
   * Сводка для Telegram (/stats): баланс, roundtrip, последние сделки, реализ. P/L Spot.
   */
  async buildTelegramTradingReport(): Promise<string> {
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
    const emPctRt =
      this.config.get<number>('binance.roundtripEmergencyDrawdownPercent') ?? 0;
    const equityBaseline =
      this.config.get<number | null>('stats.equityBaselineQuote') ?? null;

    const fmtQ = (n: number, fd = 4) =>
      n.toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: fd,
      });

    const tick24: SpotTicker24hrResult =
      await this.binanceSpot.getTicker24hr(symbol);
    const spotAscRows = await this.loadSpotExecutedAsc();
    const st = await this.prisma.botState.findUnique({
      where: { id: 'default' },
    });

    const markPrice = tick24.ok ? tick24.lastPrice : NaN;

    const balLive = hasKeys
      ? await this.binanceSpot.getAccountBalances()
      : null;

    const tracked = st?.spotTrackedBtc != null ? Number(st.spotTrackedBtc) : 0;
    const avgE = st?.spotAvgEntryUsdt != null ? Number(st.spotAvgEntryUsdt) : 0;
    const peak =
      st?.spotRoundtripPeakMarkUsdt != null
        ? Number(st.spotRoundtripPeakMarkUsdt)
        : 0;

    const out: string[] = [];

    // ── 1. БАЛАНС ──
    if (!hasKeys) {
      out.push(telegramStatsBoxTop('💲 БАЛАНС'));
      out.push(telegramStatsBoxBlank());
      out.push(
        telegramStatsLine('⚠️ Ключи API не заданы — баланс биржи недоступен.'),
      );
      out.push(telegramStatsBoxBottom());
    } else if (balLive && !balLive.ok) {
      out.push(telegramStatsBoxTop('💲 БАЛАНС'));
      out.push(telegramStatsBoxBlank());
      out.push(telegramStatsLine(`⚠️ ${balLive.error}`));
      out.push(telegramStatsBoxBottom());
    } else if (balLive?.ok) {
      const qRow = balLive.balances.find((b) => b.asset === quoteAsset);
      const bRow = balLive.balances.find((b) => b.asset === baseAsset);
      const uf = qRow ? parseFloat(qRow.free) : 0;
      const ul = qRow ? parseFloat(qRow.locked) : 0;
      const bf = bRow ? parseFloat(bRow.free) : 0;
      const bl = bRow ? parseFloat(bRow.locked) : 0;
      const quoteTot = uf + ul;
      const baseTot = bf + bl;
      const equity =
        Number.isFinite(markPrice) && markPrice > 0
          ? quoteTot + baseTot * markPrice
          : NaN;
      const baseInQuote =
        Number.isFinite(markPrice) && markPrice > 0 ? baseTot * markPrice : NaN;

      out.push(telegramStatsBoxTop('💲 БАЛАНС'));
      out.push(telegramStatsBoxBlank());
      out.push(telegramStatsLine(`💵 ${quoteAsset}:    ${fmtQ(quoteTot)}`));
      if (Number.isFinite(baseInQuote)) {
        out.push(
          telegramStatsLine(
            `🪙 ${baseAsset}:     ${fmtStatsQtyBase(baseTot)} (~${fmtQ(baseInQuote)} ${quoteAsset})`,
          ),
        );
      } else {
        out.push(
          telegramStatsLine(`🪙 ${baseAsset}:     ${fmtStatsQtyBase(baseTot)}`),
        );
      }
      out.push(telegramStatsInnerHr());
      if (Number.isFinite(equity)) {
        out.push(
          telegramStatsLine(`💼 Портфель: ${fmtQ(equity)} ${quoteAsset}`),
        );
      } else {
        out.push(telegramStatsLine('💼 Портфель: —'));
      }
      out.push(telegramStatsBoxBottom());
    }

    // ── 2. ПРИБЫЛЬ ──
    const detail = this.computeSpotTradeAnalyticsFromRows(spotAscRows);
    const agg = detail.agg;
    const unrealRt =
      spotStrategy === 'roundtrip' &&
      tracked > 0 &&
      avgE > 0 &&
      Number.isFinite(markPrice)
        ? tracked * (markPrice - avgE)
        : 0;
    const totalPnl = agg.profitFromSellsUsdt + unrealRt;

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const profitDay = this.profitForPeriod(spotAscRows, dayAgo);
    const profit3d = this.profitForPeriod(spotAscRows, threeDaysAgo);
    const profitWeek = this.profitForPeriod(spotAscRows, weekAgo);

    const fmtPnl = (v: number) => `${v >= 0 ? '+' : ''}${fmtQ(v)}`;

    out.push('');
    out.push(telegramStatsBoxTop('💰 ПРИБЫЛЬ'));
    out.push(telegramStatsBoxBlank());
    {
      let totalLine = `💎 Всего: ${fmtPnl(totalPnl)} ${quoteAsset}`;
      if (equityBaseline != null && equityBaseline > 0) {
        const pct = (totalPnl / equityBaseline) * 100;
        totalLine += ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      }
      out.push(telegramStatsLine(totalLine));
    }
    out.push(
      telegramStatsLine(`📅 За день:   ${fmtPnl(profitDay)} ${quoteAsset}`),
    );
    out.push(
      telegramStatsLine(`📅 За 3 дня:  ${fmtPnl(profit3d)} ${quoteAsset}`),
    );
    out.push(
      telegramStatsLine(`📅 За неделю: ${fmtPnl(profitWeek)} ${quoteAsset}`),
    );
    out.push(telegramStatsBoxBottom());

    // ── 3. СИГНАЛ РЫНКА ──
    try {
      const signal = await this.computeMarketEntrySignal();
      const verdictRu =
        signal.verdict === 'DA'
          ? '✅ ДА'
          : signal.verdict === 'OSTOROZHNO'
            ? '⚠️ ОСТОРОЖНО'
            : '🚫 НЕТ';
      out.push('');
      out.push(telegramStatsBoxTop('📡 СИГНАЛ РЫНКА'));
      out.push(
        telegramStatsLine(`Входить: ${verdictRu} (${signal.score}/100)`),
      );
      out.push(
        telegramStatsLine(
          `Тренд: 24h ${signal.trend24h.changePct >= 0 ? '+' : ''}${signal.trend24h.changePct.toFixed(1)}% / 7d ${signal.trend7d.changePct >= 0 ? '+' : ''}${signal.trend7d.changePct.toFixed(1)}%`,
        ),
      );
      out.push(
        telegramStatsLine(
          `σ: ${signal.volatility.stdev.toFixed(2)} (${signal.volatility.label}) · WR: ${signal.winRate.rate.toFixed(0)}%`,
        ),
      );
      out.push(telegramStatsBoxBottom());
    } catch {
      /* signal block is optional */
    }

    // ── 4. РЫНОК ──
    out.push('');
    out.push(telegramStatsBoxTop('📈 РЫНОК'));
    out.push(telegramStatsBoxBlank());
    if (tick24.ok) {
      const ch = tick24.priceChangePercent;
      out.push(
        telegramStatsLine(
          `🔸 ${baseAsset}/${quoteAsset}:    ${fmtQ(tick24.lastPrice, 2)}`,
        ),
      );
      out.push(
        telegramStatsLine(
          `🔹 Изм. 24ч:    ${ch >= 0 ? '+' : ''}${fmtStatsNumber(ch, 2, 2)}% ${pctArrow(ch)}`,
        ),
      );
      out.push(
        telegramStatsLine(`📉 Мин. 24ч:    ${fmtQ(tick24.lowPrice, 2)}`),
      );
      out.push(
        telegramStatsLine(`📈 Макс. 24ч:   ${fmtQ(tick24.highPrice, 2)}`),
      );
    } else {
      out.push(telegramStatsLine(`⚠️ Тикер 24ч: ${tick24.error}`));
      if (Number.isFinite(markPrice) && markPrice > 0) {
        out.push(
          telegramStatsLine(
            `🔸 ${baseAsset}/${quoteAsset}:    ${fmtQ(markPrice, 2)}`,
          ),
        );
      }
    }
    out.push(telegramStatsBoxBottom());

    // ── 5. ПОЗИЦИЯ ──
    out.push('');
    out.push(telegramStatsBoxTop('🎯 ПОЗИЦИЯ'));
    out.push(telegramStatsBoxBlank());
    if (!hasKeys || !balLive?.ok) {
      out.push(telegramStatsLine('— нет доступа к балансу API —'));
    } else if (spotStrategy === 'roundtrip') {
      const m = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : NaN;
      const bRow = balLive.balances.find((b) => b.asset === baseAsset);
      const baseFreeForRoundtrip = bRow ? parseFloat(bRow.free) : 0;
      if (tracked > 0 && avgE > 0) {
        const tpTh = avgE * (1 + effectiveTpPct / 100);
        const slTh = slPct > 0 ? avgE * (1 - slPct / 100) : NaN;
        const invested = tracked * avgE;
        const unreal = Number.isFinite(m) ? tracked * (m - avgE) : NaN;
        const unrealPct = Number.isFinite(m) ? ((m - avgE) / avgE) * 100 : NaN;
        out.push(
          telegramStatsLine(
            `📥 Вход: ${fmtStatsQtyBase(tracked)} ${baseAsset} @ ${fmtQ(avgE, 2)}`,
          ),
        );
        out.push(
          telegramStatsLine(`💰 Вложено: ${fmtQ(invested)} ${quoteAsset}`),
        );
        if (Number.isFinite(unreal) && Number.isFinite(unrealPct)) {
          out.push(
            telegramStatsLine(
              `💹 P&L: ${fmtPnl(unreal)} ${quoteAsset} (${unrealPct >= 0 ? '+' : ''}${fmtStatsNumber(unrealPct, 2, 2)}%)`,
            ),
          );
        }
        out.push(telegramStatsInnerHr());
        out.push(
          telegramStatsLine(
            `🟢 Тейк: ≥ ${fmtQ(tpTh, 2)} (+${effectiveTpPct}%)`,
          ),
        );
        if (slPct > 0 && Number.isFinite(slTh)) {
          out.push(
            telegramStatsLine(`🔴 Стоп: ≤ ${fmtQ(slTh, 2)} (−${slPct}%)`),
          );
        }
        if (emPctRt > 0 && peak > 0) {
          out.push(
            telegramStatsLine(
              `⚡ Авар. сброс: −${emPctRt}% от пика ${fmtQ(peak, 2)}`,
            ),
          );
        }
        out.push(telegramStatsBoxBlank());
        let status = '⏳ Ожидание...';
        if (Number.isFinite(m) && m > 0) {
          if (m >= tpTh) status = '✅ В зоне тейка';
          else if (slPct > 0 && Number.isFinite(slTh) && m <= slTh)
            status = '🔴 Зона стопа';
          else status = '⏳ Ожидание тейка...';
        }
        out.push(telegramStatsLine(status));
      } else {
        const mk = Number.isFinite(m)
          ? `марк ~${fmtQ(m, 2)} ${quoteAsset}`
          : 'марк —';
        out.push(
          telegramStatsLine(
            `📍 Нет позиции · ${baseAsset}: ${fmtStatsQtyBase(baseFreeForRoundtrip)} · ${mk}`,
          ),
        );
      }
    } else {
      out.push(
        telegramStatsLine(
          `⚙️ ${spotSide} · до ${maxQuote} ${quoteAsset}/ордер`,
        ),
      );
    }
    out.push(telegramStatsBoxBottom());

    // ── 6. СТАТИСТИКА ──
    const denom = detail.streakDenom;
    const winRate = denom > 0 ? (detail.winningSells / denom) * 100 : 0;
    const lossRate = denom > 0 ? (detail.losingSells / denom) * 100 : 0;
    const streakLine =
      detail.streakCount > 0 && detail.streakKind === 'win'
        ? `${detail.streakCount} 🟢 подряд`
        : detail.streakCount > 0 && detail.streakKind === 'loss'
          ? `${detail.streakCount} 🔴 подряд`
          : '—';

    out.push('');
    out.push(telegramStatsBoxTop('📊 СТАТИСТИКА'));
    out.push(telegramStatsBoxBlank());
    out.push(
      telegramStatsLine(
        `🔄 Сделок: ${agg.buyCount + agg.sellCount} (${agg.buyCount} покупок, ${agg.sellCount} продаж)`,
      ),
    );
    out.push(
      telegramStatsLine(
        `✅ Прибыльных: ${detail.winningSells} (${fmtStatsNumber(winRate, 0, 0)}%) · ❌ Убыт.: ${detail.losingSells} (${fmtStatsNumber(lossRate, 0, 0)}%)`,
      ),
    );
    out.push(telegramStatsLine(`📈 Серия: ${streakLine}`));
    out.push(telegramStatsBoxBottom());

    // ── 7. Футер ──
    out.push('');
    out.push(`⚙️ Бот работает: ${fmtUptimeProcess(process.uptime())}`);

    return out.join('\n');
  }

  async buildTelegramTradingHistoryReport(): Promise<string> {
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const pairFil = await this.binanceSpot.getLotSizeFilter(symbol);
    const baseAsset = pairFil.ok
      ? pairFil.baseAsset
      : symbol.replace(/USDT$|BUSD$|FDUSD$/, '') || 'SOL';

    const spotAscRows = await this.loadSpotExecutedAsc();
    const recent = await this.prisma.orderIntent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const out: string[] = [];
    out.push(telegramStatsBoxTop('📜 ИСТОРИЯ СДЕЛОК'));
    out.push(telegramStatsBoxBlank());

    if (recent.length === 0) {
      out.push(telegramStatsLine('— пока нет записей.'));
    } else {
      const histRows = this.ordersToTelegramHistoryRows(
        recent,
        spotAscRows,
        baseAsset,
      );
      const histLines = buildTelegramStatsHistoryBlocks(histRows);
      for (const line of histLines) out.push(line);
    }

    out.push(telegramStatsBoxBottom());
    return out.join('\n');
  }

  /** Агрегат исполненных Spot-ордеров (для /stats и уведомлений). */
  async getSpotExecutedAgg(): Promise<{
    buyCount: number;
    sellCount: number;
    buyUsdt: number;
    sellUsdt: number;
    profitFromSellsUsdt: number;
  }> {
    return this.aggregateSpotExecStats();
  }

  private profitForPeriod(
    rows: Array<{ createdAt: Date; payload: unknown }>,
    since: Date,
  ): number {
    let sum = 0;
    for (const r of rows) {
      if (r.createdAt < since) continue;
      const p = r.payload as SpotLivePayload | null;
      if (p?.spot?.side !== 'SELL') continue;
      const est = p.roundtrip?.realizedPnlUsdtEstimate;
      if (est != null && typeof est === 'number' && Number.isFinite(est)) {
        sum += est;
      }
    }
    return sum;
  }

  private async loadSpotExecutedAsc(): Promise<
    Array<{ id: string; createdAt: Date; payload: unknown }>
  > {
    return this.prisma.orderIntent.findMany({
      where: { provider: 'binance_spot', status: 'EXECUTED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, payload: true },
    });
  }

  private spotSellHoldMs(
    allAsc: Array<{ createdAt: Date; payload: unknown }>,
    sellIndex: number,
  ): number | null {
    for (let i = sellIndex - 1; i >= 0; i--) {
      const p = allAsc[i].payload as SpotLivePayload | null;
      if (p?.spot?.side !== 'BUY' || !p.exchangeResponse) continue;
      const { baseQty } = parseSpotExchangeFill(p.exchangeResponse);
      if (!Number.isFinite(baseQty) || baseQty <= 0) continue;
      return (
        allAsc[sellIndex].createdAt.getTime() - allAsc[i].createdAt.getTime()
      );
    }
    return null;
  }

  private computeSpotTradeAnalyticsFromRows(
    rows: Array<{ id: string; createdAt: Date; payload: unknown }>,
  ): {
    agg: {
      buyCount: number;
      sellCount: number;
      buyUsdt: number;
      sellUsdt: number;
      profitFromSellsUsdt: number;
    };
    winningSells: number;
    losingSells: number;
    flatSells: number;
    avgBuyPrice: number | null;
    avgSellPrice: number | null;
    avgHoldMs: number | null;
    bestPnl: number | null;
    bestPct: number | null;
    worstPnl: number | null;
    worstPct: number | null;
    streakCount: number;
    streakKind: 'win' | 'loss' | null;
    streakDenom: number;
  } {
    let buyCount = 0;
    let sellCount = 0;
    let buyUsdt = 0;
    let sellUsdt = 0;
    let buyBase = 0;
    let sellBase = 0;
    let profitFromSellsUsdt = 0;
    let winningSells = 0;
    let losingSells = 0;
    let flatSells = 0;
    const holdMsList: number[] = [];
    let lastBuyAt: Date | null = null;
    const sellPnlSequence: (number | null)[] = [];

    for (const r of rows) {
      const p = r.payload as SpotLivePayload | null;
      if (!p?.spot?.side || !p.exchangeResponse) continue;
      const { baseQty, quoteQty } = parseSpotExchangeFill(p.exchangeResponse);
      if (!Number.isFinite(quoteQty) || !Number.isFinite(baseQty)) continue;
      if (p.spot.side === 'BUY') {
        buyCount++;
        buyUsdt += quoteQty;
        buyBase += baseQty;
        lastBuyAt = r.createdAt;
      } else if (p.spot.side === 'SELL') {
        sellCount++;
        sellUsdt += quoteQty;
        sellBase += baseQty;
        if (lastBuyAt) {
          holdMsList.push(r.createdAt.getTime() - lastBuyAt.getTime());
          lastBuyAt = null;
        }
        const rp = p.roundtrip?.realizedPnlUsdtEstimate;
        if (rp != null && Number.isFinite(rp)) {
          profitFromSellsUsdt += rp;
          sellPnlSequence.push(rp);
          if (rp > 0) winningSells++;
          else if (rp < 0) losingSells++;
          else flatSells++;
        } else {
          sellPnlSequence.push(null);
          flatSells++;
        }
      }
    }

    let bestPnl: number | null = null;
    let bestPct: number | null = null;
    let worstPnl: number | null = null;
    let worstPct: number | null = null;
    for (const r of rows) {
      const p = r.payload as SpotLivePayload | null;
      if (p?.spot?.side !== 'SELL' || !p.exchangeResponse) continue;
      const rp = p.roundtrip?.realizedPnlUsdtEstimate;
      if (rp == null || !Number.isFinite(rp)) continue;
      const { quoteQty } = parseSpotExchangeFill(p.exchangeResponse);
      const cost = quoteQty - rp;
      const pct = cost > 0 ? (rp / cost) * 100 : Number.NaN;
      if (bestPnl == null || rp > bestPnl) {
        bestPnl = rp;
        bestPct = Number.isFinite(pct) ? pct : null;
      }
      if (rp < 0 && (worstPnl == null || rp < worstPnl)) {
        worstPnl = rp;
        worstPct = Number.isFinite(pct) ? pct : null;
      }
    }

    let streakCount = 0;
    let streakKind: 'win' | 'loss' | null = null;
    for (let i = sellPnlSequence.length - 1; i >= 0; i--) {
      const pnl = sellPnlSequence[i];
      if (pnl == null || !Number.isFinite(pnl)) break;
      if (pnl === 0) break;
      const w = pnl > 0;
      if (streakKind == null) {
        streakKind = w ? 'win' : 'loss';
        streakCount = 1;
      } else if (streakKind === 'win' && w) streakCount++;
      else if (streakKind === 'loss' && !w) streakCount++;
      else break;
    }

    const streakDenom = winningSells + losingSells;
    const avgBuyPrice =
      buyBase > 0 && Number.isFinite(buyUsdt / buyBase)
        ? buyUsdt / buyBase
        : null;
    const avgSellPrice =
      sellBase > 0 && Number.isFinite(sellUsdt / sellBase)
        ? sellUsdt / sellBase
        : null;
    const avgHoldMs =
      holdMsList.length > 0
        ? holdMsList.reduce((a, b) => a + b, 0) / holdMsList.length
        : null;

    return {
      agg: {
        buyCount,
        sellCount,
        buyUsdt,
        sellUsdt,
        profitFromSellsUsdt,
      },
      winningSells,
      losingSells,
      flatSells,
      avgBuyPrice,
      avgSellPrice,
      avgHoldMs,
      bestPnl,
      bestPct,
      worstPnl,
      worstPct,
      streakCount,
      streakKind,
      streakDenom,
    };
  }

  private ordersToTelegramHistoryRows(
    recent: Array<{
      id: string;
      createdAt: Date;
      provider: string;
      side: string;
      status: string;
      payload: unknown;
    }>,
    spotAsc: Array<{ id: string; createdAt: Date; payload: unknown }>,
    baseAsset: string,
  ): TelegramStatsHistoryRow[] {
    const idToIdx = new Map(spotAsc.map((r, i) => [r.id, i]));
    const rows: TelegramStatsHistoryRow[] = [];
    for (const r of recent) {
      if (r.provider === 'binance_spot' && r.status === 'EXECUTED') {
        const p = r.payload as SpotLivePayload | null;
        const ex = p?.exchangeResponse;
        const { baseQty, quoteQty } = parseSpotExchangeFill(ex);
        const qa = p?.spot?.quoteAsset ?? 'USDT';
        const sd = p?.spot?.side;
        if (
          sd === 'BUY' &&
          Number.isFinite(quoteQty) &&
          Number.isFinite(baseQty) &&
          baseQty > 0
        ) {
          const avgPx = quoteQty / baseQty;
          rows.push({
            kind: 'spot_buy',
            at: r.createdAt,
            baseQty,
            quoteQty,
            avgPrice: avgPx,
            baseAsset,
            quoteAsset: qa,
          });
          continue;
        }
        if (
          sd === 'SELL' &&
          Number.isFinite(quoteQty) &&
          Number.isFinite(baseQty) &&
          baseQty > 0
        ) {
          const avgPx = quoteQty / baseQty;
          const idx = idToIdx.get(r.id);
          const holdMs = idx != null ? this.spotSellHoldMs(spotAsc, idx) : null;
          rows.push({
            kind: 'spot_sell',
            at: r.createdAt,
            baseQty,
            quoteQty,
            avgPrice: avgPx,
            baseAsset,
            quoteAsset: qa,
            exitKind: p?.roundtrip?.exitKind,
            realizedPnlUsdt: p?.roundtrip?.realizedPnlUsdtEstimate,
            holdMs,
          });
          continue;
        }
      }
      rows.push({
        kind: 'other',
        line: this.formatOperationLine(
          {
            createdAt: r.createdAt,
            provider: r.provider,
            side: r.side,
            status: r.status,
            payload: r.payload,
          },
          baseAsset,
        ),
      });
    }
    return rows;
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

  /** P/L: зелёный треугольник вверх / красный треугольник вниз. */
  private arrowForPnl(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '➖';
    if (v > 0) return '🟢🔺';
    if (v < 0) return '🔴🔻';
    return '➖';
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
        const avgPx = baseQty > 0 ? quoteQty / baseQty : NaN;
        return `• ${t} | 📥 ${baseQty.toFixed(8)} ${baseAsset} @~${Number.isFinite(avgPx) ? avgPx.toFixed(2) : '—'} ${qa} · −${quoteQty.toFixed(4)} ${qa}`;
      }
      if (
        sd === 'SELL' &&
        Number.isFinite(quoteQty) &&
        Number.isFinite(baseQty)
      ) {
        const ek = p?.roundtrip?.exitKind;
        const reason =
          ek === 'stop_loss'
            ? '🛡стоп'
            : ek === 'emergency_drawdown'
              ? '⚡авария'
              : ek === 'take_profit'
                ? '🎯тейк'
                : '💸';
        const avgPx = baseQty > 0 ? quoteQty / baseQty : NaN;
        const px = Number.isFinite(avgPx) ? avgPx.toFixed(2) : '—';
        const arr = this.arrowForPnl(rtp ?? null);
        let tail = '';
        if (rtp != null && Number.isFinite(rtp)) {
          tail = ` ${rtp >= 0 ? '+' : ''}${rtp.toFixed(4)} ${qa}`;
        }
        return `• ${t} | ${arr} ${baseQty.toFixed(8)} ${baseAsset} @~${px} · ${quoteQty.toFixed(4)} ${qa} · ${reason}${tail}`;
      }
      return `• ${t} | ${sd ?? '?'} ${p?.spot?.symbol ?? ''} (детали не распарсились)`;
    }
    return `• ${t} | ${r.provider} ${r.status}`;
  }
}
