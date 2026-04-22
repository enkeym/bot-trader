import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import {
  BinanceSpotService,
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
} from '../binance/spot-roundtrip.util';
import { PrismaService } from '../prisma/prisma.service';
import { RegimeService } from '../strategy/regime.service';
import { RiskService } from '../risk/risk.service';
import { GeminiService } from '../ai/gemini.service';
import { parseSpotExchangeFill } from './balance-telegram.format';
import { OrderIntentService } from './order-intent.service';
import {
  buildTelegramStatsHistoryBlocks,
  fmtStatsNumber,
  fmtUptimeProcess,
  TelegramStatsHistoryRow,
} from './telegram-trading-report.format';

export type SpotExitKind =
  | 'take_profit'
  | 'stop_loss'
  | 'emergency_drawdown'
  | 'trailing_stop';

/**
 * Реальный Spot-ордер: ответ биржи + учётное состояние позиции.
 */
export type SpotLivePayload = {
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
  /** Состояние roundtrip после сделки и марк на момент решения. */
  roundtrip?: {
    trackedBtcAfter: number;
    avgEntryUsdtAfter: number;
    takeProfitPercent: number;
    markPrice: number;
    tpPriceUsdt?: number;
    slPriceUsdt?: number;
    trailingStopUsdt?: number;
    realizedPnlUsdtEstimate?: number | null;
    exitKind?: SpotExitKind;
  };
  /** Решение AI-фильтра (если вызывался). */
  ai?: {
    consulted: boolean;
    action: 'BUY' | 'SKIP' | null;
    confidence: number | null;
    reason: string;
  };
  error?: string;
  code?: number;
};

/** Результат одного тика автоторговли. */
export interface SimulationTickResult {
  ok: boolean;
  executionMode: string | undefined;
  orderCreated: boolean;
  order: {
    id: string;
    provider: string;
    side: string;
    status: string;
    payload: unknown;
  } | null;
  /** Только для тестнет-тега в сообщениях. */
  isTestnet: boolean;
}

const BOT_STATE_ID = 'default';

/**
 * Ключевая логика roundtrip Spot: ATR-SL/TP, трейлинг, учёт комиссий, сайзинг по риску.
 */
@Injectable()
export class SimulationService {
  private readonly log = new Logger(SimulationService.name);

  constructor(
    private readonly risk: RiskService,
    private readonly orders: OrderIntentService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly binanceSpot: BinanceSpotService,
    private readonly regime: RegimeService,
    private readonly ai: GeminiService,
  ) {}

  async runPairSimulation(notionalCap: number): Promise<SimulationTickResult> {
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const spotBaseUrl =
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com';
    const isTestnet = spotBaseUrl.includes('testnet');
    const executionMode = this.config.get<string>('executionMode');

    if (!this.binanceSpot.spotExecutionAllowed()) {
      await this.audit.log('warn', 'spot_execution_blocked', {
        message: 'Нет BINANCE_API_KEY / BINANCE_API_SECRET.',
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }

    const tick = await this.binanceSpot.getTickerPrice(symbol);
    if (!tick.ok) {
      await this.audit.log('warn', 'tick_skip', {
        reason: 'ticker_failed',
        error: tick.error,
        symbol,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }
    const markPrice = tick.price;

    const symFil = await this.binanceSpot.getLotSizeFilter(symbol);
    if (!symFil.ok) {
      await this.audit.log('warn', 'tick_skip', {
        reason: 'lot_filter_failed',
        error: symFil.error,
        symbol,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }
    const { baseAsset, quoteAsset } = symFil;

    const st = await this.prisma.botState.findUnique({
      where: { id: BOT_STATE_ID },
    });
    const tracked = Number(st?.spotTrackedBtc ?? 0);
    const avgEntry = Number(st?.spotAvgEntryUsdt ?? 0);
    const prevPeak = Number(st?.spotRoundtripPeakMarkUsdt ?? 0);
    const prevTrail = Number(st?.spotTrailingStopUsdt ?? 0);
    const prevTp = Number(st?.spotTpPriceUsdt ?? 0);
    const prevSl = Number(st?.spotSlPriceUsdt ?? 0);
    const lastSellAt = st?.spotRoundtripLastSellAt ?? null;

    const peakMark = computePeakMarkPrice({
      trackedBtc: tracked,
      prevPeakMarkUsdt: prevPeak,
      markPrice,
    });

    if (tracked > 0) {
      return this.manageOpenPosition({
        symbol,
        spotBaseUrl,
        isTestnet,
        executionMode,
        markPrice,
        peakMark,
        tracked,
        avgEntry,
        tpPrice: prevTp,
        slPrice: prevSl,
        trailStop: prevTrail,
        baseAsset,
        quoteAsset,
        lot: symFil.lot,
        minNotionalQuote: symFil.minNotionalQuote,
      });
    }

    return this.tryOpenPosition({
      symbol,
      spotBaseUrl,
      isTestnet,
      executionMode,
      markPrice,
      baseAsset,
      quoteAsset,
      minNotionalQuote: symFil.minNotionalQuote,
      notionalCap,
      lastSellAt,
    });
  }

  private async manageOpenPosition(p: {
    symbol: string;
    spotBaseUrl: string;
    isTestnet: boolean;
    executionMode: string | undefined;
    markPrice: number;
    peakMark: number;
    tracked: number;
    avgEntry: number;
    tpPrice: number;
    slPrice: number;
    trailStop: number;
    baseAsset: string;
    quoteAsset: string;
    lot: { minQty: number; stepSize: number };
    minNotionalQuote: number;
  }): Promise<SimulationTickResult> {
    const {
      symbol,
      spotBaseUrl,
      isTestnet,
      executionMode,
      markPrice,
      peakMark,
      tracked,
      avgEntry,
      tpPrice,
      slPrice,
      trailStop,
      baseAsset,
      quoteAsset,
      lot,
      minNotionalQuote,
    } = p;

    const emergencyPct =
      this.config.get<number>('binance.roundtripEmergencyDrawdownPercent') ?? 0;

    const feePct = this.config.get<number>('strategy.spotTakerFeePercent') ?? 0;
    const minNetTpPct =
      this.config.get<number>('strategy.minNetTpPercent') ?? 0;
    const tpPctCfg =
      tpPrice > 0 && avgEntry > 0 ? ((tpPrice - avgEntry) / avgEntry) * 100 : 0;
    const slPctCfg =
      slPrice > 0 && avgEntry > 0 ? ((avgEntry - slPrice) / avgEntry) * 100 : 0;
    // Эффективный TP считаем только если позиция открыта с явным уровнем TP.
    // На legacy-позициях без TP/SL (tpPrice=0) полагаемся на emergency-drawdown.
    const effectiveTpPct =
      tpPctCfg > 0
        ? effectiveTakeProfitPercent({
            configuredPercent: tpPctCfg,
            minPercent: minNetTpPct,
            assumedRoundtripFeePercent: 2 * feePct,
          })
        : 0;

    const slHit =
      slPrice > 0 &&
      priceHitsStopLoss({
        markPrice,
        avgEntryUsdt: avgEntry,
        stopLossPercent: slPctCfg,
      });
    const emergencyHit =
      emergencyPct > 0 &&
      priceHitsEmergencyDrawdown({
        markPrice,
        peakMarkUsdt: peakMark,
        drawdownPercent: emergencyPct,
      });
    const trailingHit = trailStop > 0 && markPrice <= trailStop;
    const tpHit =
      effectiveTpPct > 0 &&
      priceHitsTakeProfit({
        markPrice,
        avgEntryUsdt: avgEntry,
        takeProfitPercent: effectiveTpPct,
      });

    const exitKind: SpotExitKind | null = slHit
      ? 'stop_loss'
      : emergencyHit
        ? 'emergency_drawdown'
        : trailingHit
          ? 'trailing_stop'
          : tpHit
            ? 'take_profit'
            : null;

    if (exitKind == null) {
      const divMaxPct =
        this.config.get<number>('binance.roundtripBalanceDivergenceMaxPct') ??
        0;
      if (divMaxPct > 0) {
        const bal = await this.binanceSpot.getAccountBalances();
        if (bal.ok) {
          const row = bal.balances.find((b) => b.asset === baseAsset);
          const freeB = row != null ? parseFloat(row.free) : 0;
          const { block, deviationPct } = balanceDivergenceBlocksRoundtrip({
            freeBase: freeB,
            trackedBase: tracked,
            maxDivergencePct: divMaxPct,
          });
          if (block) {
            await this.audit.log('warn', 'tick_skip', {
              reason: 'balance_divergence',
              tracked,
              freeBase: freeB,
              deviationPct,
              maxAllowedPct: divMaxPct,
              baseAsset,
              symbol,
            });
          }
        }
      }

      const activationMult =
        this.config.get<number>('strategy.atrTrailActivationMult') ?? 1.0;
      const riskDist = avgEntry - slPrice;
      const activationAbs = riskDist * activationMult;
      const profitAbs = markPrice - avgEntry;
      let newTrail = trailStop;
      if (profitAbs >= activationAbs && riskDist > 0) {
        const candidate = markPrice - riskDist;
        newTrail = Math.max(trailStop, candidate, slPrice);
      }

      await this.persistState({
        tracked,
        avgEntry,
        peakMark,
        trailStop: newTrail,
        tpPrice,
        slPrice,
        recordSellCooldown: false,
      });
      await this.audit.log('info', 'tick_hold_position', {
        symbol,
        markPrice,
        avgEntry,
        tpPrice,
        slPrice,
        trailStop: newTrail,
        peakMark,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }

    const bal = await this.binanceSpot.getAccountBalances();
    if (!bal.ok) {
      await this.audit.log('warn', 'tick_skip', {
        reason: 'balance_failed',
        error: bal.error,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }
    const row = bal.balances.find((b) => b.asset === baseAsset);
    const freeBase = row != null ? parseFloat(row.free) : 0;
    const { quantity, skipReason, belowMinNotional } =
      computeSellQuantityRespectingMinNotional({
        freeBtc: freeBase,
        trackedBtc: tracked,
        lot,
        markPriceQuote: markPrice,
        minNotionalQuote,
      });
    if (quantity <= 0) {
      if (belowMinNotional) {
        await this.audit.log('warn', 'roundtrip_dust_below_min_notional', {
          reason: 'dust',
          skipReason,
          tracked,
          markPrice,
          minNotionalQuote,
          quoteAsset,
          symbol,
        });
        await this.persistState({
          tracked: 0,
          avgEntry: 0,
          peakMark: 0,
          trailStop: 0,
          tpPrice: 0,
          slPrice: 0,
          recordSellCooldown: false,
        });
      } else {
        await this.audit.log('info', 'tick_skip', {
          reason: 'sell_qty_unavailable',
          skipReason,
          symbol,
        });
      }
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }

    const placed = await this.binanceSpot.placeMarketOrder({
      symbol,
      side: 'SELL',
      quantity,
    });

    if (!placed.ok) {
      return this.recordFailedOrder({
        side: 'SELL',
        symbol,
        spotBaseUrl,
        baseAsset,
        quoteAsset,
        isTestnet,
        executionMode,
        error: placed.error,
        code: placed.code,
        markPrice,
      });
    }

    const { executedQty, cumQuote } = parseFill(placed.data);
    const received = cumQuote;
    const costBasis = executedQty * avgEntry;
    const realizedEst = received - costBasis;

    const after = applySellFill({
      trackedBtc: tracked,
      avgEntryUsdt: avgEntry,
      soldBtc: executedQty,
    });

    await this.persistState({
      tracked: after.trackedBtc,
      avgEntry: after.avgEntryUsdt,
      peakMark: after.trackedBtc > 0 ? Math.max(peakMark, markPrice) : 0,
      trailStop: after.trackedBtc > 0 ? trailStop : 0,
      tpPrice: after.trackedBtc > 0 ? tpPrice : 0,
      slPrice: after.trackedBtc > 0 ? slPrice : 0,
      recordSellCooldown: after.trackedBtc <= 1e-12,
    });

    const payload: SpotLivePayload = {
      spot: {
        baseUrl: spotBaseUrl,
        symbol,
        side: 'SELL',
        quantity,
        baseAsset,
        quoteAsset,
      },
      exchangeResponse: placed.data,
      roundtrip: {
        trackedBtcAfter: after.trackedBtc,
        avgEntryUsdtAfter: after.avgEntryUsdt,
        takeProfitPercent: effectiveTpPct,
        markPrice,
        tpPriceUsdt: tpPrice,
        slPriceUsdt: slPrice,
        trailingStopUsdt: trailStop,
        realizedPnlUsdtEstimate: realizedEst,
        exitKind,
      },
    };

    const key = `spot-SELL-${this.hashKey(symbol, markPrice)}`;
    const { record, created } = await this.orders.createIdempotent({
      idempotencyKey: key,
      provider: 'binance_spot',
      side: 'SPOT_SELL_MARKET',
      status: 'EXECUTED',
      payload: payload as Record<string, unknown>,
    });
    await this.audit.log('info', 'spot_order_recorded', {
      orderIntentId: record.id,
      idempotencyKey: key,
      symbol,
      orderId: placed.data['orderId'],
      side: 'SELL',
      exitKind,
    });

    return {
      ok: true,
      executionMode,
      orderCreated: created,
      order: record,
      isTestnet,
    };
  }

  private async tryOpenPosition(p: {
    symbol: string;
    spotBaseUrl: string;
    isTestnet: boolean;
    executionMode: string | undefined;
    markPrice: number;
    baseAsset: string;
    quoteAsset: string;
    minNotionalQuote: number;
    notionalCap: number;
    lastSellAt: Date | null;
  }): Promise<SimulationTickResult> {
    const {
      symbol,
      spotBaseUrl,
      isTestnet,
      executionMode,
      baseAsset,
      quoteAsset,
      minNotionalQuote,
      notionalCap,
      lastSellAt,
    } = p;

    const cooldownMs =
      this.config.get<number>('binance.buyCooldownAfterSellMs') ?? 0;
    if (cooldownMs > 0 && lastSellAt != null) {
      const elapsed = Date.now() - lastSellAt.getTime();
      if (elapsed < cooldownMs) {
        await this.audit.log('info', 'tick_skip', {
          reason: 'cooldown_after_sell',
          elapsedMs: elapsed,
          cooldownMs,
          symbol,
        });
        return {
          ok: true,
          executionMode,
          orderCreated: false,
          order: null,
          isTestnet,
        };
      }
    }

    const regime = await this.regime.evaluateBuySetup(symbol);
    if (!regime.ok) {
      await this.audit.log('info', 'tick_skip_regime', {
        reason: regime.reason,
        diagnostics: regime.diagnostics,
        symbol,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }

    const aiDecision = await this.ai.confirmEntry({
      symbol,
      markPrice: regime.markPrice,
      ema20: regime.ema20,
      ema50: regime.ema50,
      ema200: regime.ema200,
      ema50_4h: regime.ema50_4h,
      rsi14: regime.rsi14,
      adx14: regime.adx14,
      atr14: regime.atr,
      slPercent: regime.slPercent,
      tpPercent: regime.tpPercent,
      recentCloses1h: [],
      recentCloses4h: [],
    });
    const minConf = this.config.get<number>('ai.minConfidence') ?? 60;
    if (
      aiDecision.consulted &&
      (aiDecision.action === 'SKIP' || (aiDecision.confidence ?? 0) < minConf)
    ) {
      await this.audit.log('info', 'tick_skip_ai', {
        action: aiDecision.action,
        confidence: aiDecision.confidence,
        reason: aiDecision.reason,
        symbol,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }

    const bal = await this.binanceSpot.getAccountBalances();
    if (!bal.ok) {
      await this.audit.log('warn', 'tick_skip', {
        reason: 'balance_failed',
        error: bal.error,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }
    const qRow = bal.balances.find((b) => b.asset === quoteAsset);
    const bRow = bal.balances.find((b) => b.asset === baseAsset);
    const freeQuote = qRow != null ? parseFloat(qRow.free) : 0;
    const lockQuote = qRow != null ? parseFloat(qRow.locked) : 0;
    const freeBase = bRow != null ? parseFloat(bRow.free) : 0;
    const lockBase = bRow != null ? parseFloat(bRow.locked) : 0;
    const equity =
      freeQuote + lockQuote + (freeBase + lockBase) * regime.markPrice;

    const riskNotional = this.risk.riskBasedNotional({
      equityUsdt: equity,
      slPercent: regime.slPercent,
    });
    const maxQuote = this.config.get<number>('binance.spotMaxQuoteUsdt') ?? 20;
    const maxPosQuote =
      this.config.get<number>('binance.roundtripMaxPositionUsdt') ?? 0;

    let quoteOrderQty = Math.min(riskNotional, notionalCap, maxQuote);
    if (maxPosQuote > 0 && quoteOrderQty > maxPosQuote) {
      quoteOrderQty = maxPosQuote;
    }

    // Защита от низкой ликвидности: не заходим крупнее 5% от среднего 1h объёма в quote.
    const tick24 = await this.binanceSpot.getTicker24hr(symbol);
    if (tick24.ok) {
      const quoteVol24h = tick24.volume * tick24.lastPrice;
      const quoteVol1hAvg = quoteVol24h / 24;
      const liquidityCap = quoteVol1hAvg * 0.05;
      if (liquidityCap > 0 && quoteOrderQty > liquidityCap) {
        await this.audit.log('info', 'tick_skip', {
          reason: 'low_liquidity',
          quoteOrderQty,
          liquidityCap1hPercent5: liquidityCap,
          symbol,
        });
        return {
          ok: true,
          executionMode,
          orderCreated: false,
          order: null,
          isTestnet,
        };
      }
    }

    const minNotional = Math.max(
      minNotionalQuote,
      this.risk.minOrderNotionalUsdt,
    );
    if (!(quoteOrderQty >= minNotional)) {
      await this.audit.log('info', 'tick_skip', {
        reason: 'notional_below_min',
        quoteOrderQty,
        minNotional,
        equity,
        slPercent: regime.slPercent,
        symbol,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }
    if (freeQuote < quoteOrderQty) {
      await this.audit.log('warn', 'tick_skip', {
        reason: 'insufficient_quote',
        freeQuote,
        need: quoteOrderQty,
        symbol,
      });
      return {
        ok: true,
        executionMode,
        orderCreated: false,
        order: null,
        isTestnet,
      };
    }

    const placed = await this.binanceSpot.placeMarketOrder({
      symbol,
      side: 'BUY',
      quoteOrderQty,
    });
    if (!placed.ok) {
      return this.recordFailedOrder({
        side: 'BUY',
        symbol,
        spotBaseUrl,
        baseAsset,
        quoteAsset,
        isTestnet,
        executionMode,
        error: placed.error,
        code: placed.code,
        markPrice: regime.markPrice,
      });
    }

    const { executedQty, cumQuote } = parseFill(placed.data);
    const fill = applyBuyFill({
      trackedBtc: 0,
      avgEntryUsdt: 0,
      executedBtc: executedQty,
      quoteUsdtSpent: cumQuote,
    });

    const entry = fill.avgEntryUsdt;
    const slPrice = entry * (1 - regime.slPercent / 100);
    const tpPrice = entry * (1 + regime.tpPercent / 100);

    await this.persistState({
      tracked: fill.trackedBtc,
      avgEntry: entry,
      peakMark: entry,
      trailStop: 0,
      tpPrice,
      slPrice,
      recordSellCooldown: false,
    });

    const payload: SpotLivePayload = {
      spot: {
        baseUrl: spotBaseUrl,
        symbol,
        side: 'BUY',
        quoteOrderQty,
        baseAsset,
        quoteAsset,
      },
      exchangeResponse: placed.data,
      roundtrip: {
        trackedBtcAfter: fill.trackedBtc,
        avgEntryUsdtAfter: entry,
        takeProfitPercent: regime.tpPercent,
        markPrice: regime.markPrice,
        tpPriceUsdt: tpPrice,
        slPriceUsdt: slPrice,
        trailingStopUsdt: 0,
      },
      ai: {
        consulted: aiDecision.consulted,
        action: aiDecision.action,
        confidence: aiDecision.confidence,
        reason: aiDecision.reason,
      },
    };

    const key = `spot-BUY-${this.hashKey(symbol, regime.markPrice)}`;
    const { record, created } = await this.orders.createIdempotent({
      idempotencyKey: key,
      provider: 'binance_spot',
      side: 'SPOT_BUY_MARKET',
      status: 'EXECUTED',
      payload: payload as Record<string, unknown>,
    });
    await this.audit.log('info', 'spot_order_recorded', {
      orderIntentId: record.id,
      idempotencyKey: key,
      symbol,
      orderId: placed.data['orderId'],
      side: 'BUY',
      ai: aiDecision.consulted ? aiDecision.action : null,
      confidence: aiDecision.confidence,
    });

    return {
      ok: true,
      executionMode,
      orderCreated: created,
      order: record,
      isTestnet,
    };
  }

  private async recordFailedOrder(args: {
    side: 'BUY' | 'SELL';
    symbol: string;
    spotBaseUrl: string;
    baseAsset: string;
    quoteAsset: string;
    isTestnet: boolean;
    executionMode: string | undefined;
    error: string;
    code: number | undefined;
    markPrice: number;
  }): Promise<SimulationTickResult> {
    const {
      side,
      symbol,
      spotBaseUrl,
      baseAsset,
      quoteAsset,
      isTestnet,
      executionMode,
      error,
      code,
      markPrice,
    } = args;

    const payload: SpotLivePayload = {
      spot: {
        baseUrl: spotBaseUrl,
        symbol,
        side,
        baseAsset,
        quoteAsset,
      },
      error,
      code,
    };

    await this.audit.log('error', 'spot_order_failed', { error, code, symbol });
    const failId = createHash('sha256')
      .update(`spot-${side}-fail-${symbol}-${markPrice}-${Date.now()}`)
      .digest('hex')
      .slice(0, 32);
    const failed = await this.prisma.orderIntent.create({
      data: {
        idempotencyKey: failId,
        provider: 'binance_spot',
        side: `SPOT_${side}_MARKET`,
        status: 'FAILED',
        payload: payload as object,
      },
    });
    return {
      ok: true,
      executionMode,
      orderCreated: true,
      order: failed,
      isTestnet,
    };
  }

  private async persistState(s: {
    tracked: number;
    avgEntry: number;
    peakMark: number;
    trailStop: number;
    tpPrice: number;
    slPrice: number;
    recordSellCooldown: boolean;
  }) {
    const t = Number(s.tracked.toFixed(8));
    const a = Number(s.avgEntry.toFixed(8));
    const pk = Number(s.peakMark.toFixed(8));
    const tr = Number(s.trailStop.toFixed(8));
    const tp = Number(s.tpPrice.toFixed(8));
    const sl = Number(s.slPrice.toFixed(8));
    await this.prisma.botState.upsert({
      where: { id: BOT_STATE_ID },
      create: {
        id: BOT_STATE_ID,
        spotTrackedBtc: new Prisma.Decimal(String(t)),
        spotAvgEntryUsdt: new Prisma.Decimal(String(a)),
        spotRoundtripPeakMarkUsdt: new Prisma.Decimal(String(pk)),
        spotTrailingStopUsdt: new Prisma.Decimal(String(tr)),
        spotTpPriceUsdt: new Prisma.Decimal(String(tp)),
        spotSlPriceUsdt: new Prisma.Decimal(String(sl)),
        spotRoundtripLastSellAt: s.recordSellCooldown ? new Date() : null,
      },
      update: {
        spotTrackedBtc: new Prisma.Decimal(String(t)),
        spotAvgEntryUsdt: new Prisma.Decimal(String(a)),
        spotRoundtripPeakMarkUsdt: new Prisma.Decimal(String(pk)),
        spotTrailingStopUsdt: new Prisma.Decimal(String(tr)),
        spotTpPriceUsdt: new Prisma.Decimal(String(tp)),
        spotSlPriceUsdt: new Prisma.Decimal(String(sl)),
        ...(s.recordSellCooldown
          ? { spotRoundtripLastSellAt: new Date() }
          : {}),
      },
    });
  }

  private hashKey(symbol: string, mark: number): string {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return createHash('sha256')
      .update(`${symbol}-${minuteBucket}-${mark.toFixed(4)}`)
      .digest('hex')
      .slice(0, 32);
  }

  async getSpotExecutedAgg(): Promise<{
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
    return { buyCount, sellCount, buyUsdt, sellUsdt, profitFromSellsUsdt };
  }

  /**
   * Компактный отчёт /stats: баланс, прибыль, рынок, позиция, статистика.
   * Все суммы идут с процентом изменения.
   */
  async buildTelegramTradingReport(): Promise<string> {
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const spotBaseUrl =
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com';
    const isTestnet = spotBaseUrl.includes('testnet');
    const hasKeys = this.binanceSpot.spotExecutionAllowed();

    const pairFil = await this.binanceSpot.getLotSizeFilter(symbol);
    const baseAsset = pairFil.ok
      ? pairFil.baseAsset
      : symbol.replace(/USDT$|BUSD$|FDUSD$/, '') || 'SOL';
    const quoteAsset = pairFil.ok ? pairFil.quoteAsset : 'USDT';

    const tick24: SpotTicker24hrResult =
      await this.binanceSpot.getTicker24hr(symbol);
    const mark = tick24.ok ? tick24.lastPrice : NaN;

    const bal = hasKeys ? await this.binanceSpot.getAccountBalances() : null;
    const st = await this.prisma.botState.findUnique({
      where: { id: BOT_STATE_ID },
    });
    const tracked = st?.spotTrackedBtc != null ? Number(st.spotTrackedBtc) : 0;
    const avgE = st?.spotAvgEntryUsdt != null ? Number(st.spotAvgEntryUsdt) : 0;
    const tpPrice =
      st?.spotTpPriceUsdt != null ? Number(st.spotTpPriceUsdt) : 0;
    const slPrice =
      st?.spotSlPriceUsdt != null ? Number(st.spotSlPriceUsdt) : 0;
    const trail =
      st?.spotTrailingStopUsdt != null ? Number(st.spotTrailingStopUsdt) : 0;

    const spotAsc = await this.loadSpotExecutedAsc();
    const detail = this.computeSpotTradeAnalytics(spotAsc);
    const agg = detail.agg;
    const unrealRt =
      tracked > 0 && avgE > 0 && Number.isFinite(mark)
        ? tracked * (mark - avgE)
        : 0;
    const totalPnl = agg.profitFromSellsUsdt + unrealRt;
    const equityBaseline =
      this.config.get<number | null>('stats.equityBaselineQuote') ?? null;

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const profitDay = this.profitForPeriod(spotAsc, dayAgo);
    const profitWeek = this.profitForPeriod(spotAsc, weekAgo);
    const profitMonth = this.profitForPeriod(spotAsc, monthAgo);

    const out: string[] = [];
    if (isTestnet) out.push('⚠️ TESTNET');

    if (!hasKeys) {
      out.push('💲 Баланс: нет ключей API');
    } else if (bal && !bal.ok) {
      out.push(`💲 Баланс: ${bal.error}`);
    } else if (bal?.ok) {
      const qRow = bal.balances.find((b) => b.asset === quoteAsset);
      const bRow = bal.balances.find((b) => b.asset === baseAsset);
      const qTot =
        (qRow ? parseFloat(qRow.free) : 0) +
        (qRow ? parseFloat(qRow.locked) : 0);
      const bTot =
        (bRow ? parseFloat(bRow.free) : 0) +
        (bRow ? parseFloat(bRow.locked) : 0);
      const baseVal = Number.isFinite(mark) ? bTot * mark : 0;
      const equity = qTot + baseVal;
      out.push(
        `💲 ${quoteAsset}: ${fmtMoney(qTot)} · ${baseAsset}: ${fmtQty(bTot)} (~${fmtMoney(baseVal)}$)`,
      );
      out.push(`💼 Портфель: ${fmtMoney(equity)}$`);
    }

    out.push('');
    out.push(`💰 Всего: ${fmtPnl(totalPnl, equityBaseline)}`);
    out.push(
      `📅 День: ${fmtPnl(profitDay, equityBaseline)} · Неделя: ${fmtPnl(profitWeek, equityBaseline)} · 30д: ${fmtPnl(profitMonth, equityBaseline)}`,
    );

    out.push('');
    if (tick24.ok) {
      const ch = tick24.priceChangePercent;
      const sign = ch >= 0 ? '+' : '';
      out.push(
        `📈 ${baseAsset}/${quoteAsset}: ${fmtMoney(tick24.lastPrice)} (${sign}${ch.toFixed(2)}% 24ч)`,
      );
    } else {
      out.push(`📈 Рынок: ${tick24.error}`);
    }

    out.push('');
    if (tracked > 0 && avgE > 0) {
      const unreal = Number.isFinite(mark) ? tracked * (mark - avgE) : NaN;
      const unrealPct = Number.isFinite(mark)
        ? ((mark - avgE) / avgE) * 100
        : NaN;
      out.push(
        `🎯 Позиция: ${fmtQty(tracked)} ${baseAsset} @ ${fmtMoney(avgE)} · ${fmtSignedPct(unreal, unrealPct)}`,
      );
      if (tpPrice > 0) out.push(`🟢 TP: ${fmtMoney(tpPrice)}`);
      if (slPrice > 0) out.push(`🔴 SL: ${fmtMoney(slPrice)}`);
      if (trail > 0) out.push(`📉 Трейл: ${fmtMoney(trail)}`);
    } else {
      out.push('📍 Нет позиции');
    }

    const denom = detail.winningSells + detail.losingSells;
    const wr = denom > 0 ? (detail.winningSells / denom) * 100 : 0;
    out.push('');
    out.push(
      `📊 Сделок: ${agg.buyCount + agg.sellCount} · WR: ${wr.toFixed(0)}% (${detail.winningSells}/${detail.losingSells})`,
    );
    const streak =
      detail.streakCount > 0
        ? detail.streakKind === 'win'
          ? `${detail.streakCount}🟢`
          : `${detail.streakCount}🔴`
        : '—';
    out.push(
      `📈 Серия: ${streak} · Uptime: ${fmtUptimeProcess(process.uptime())}`,
    );

    return out.join('\n');
  }

  async buildTelegramTradingHistoryReport(): Promise<string> {
    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const pairFil = await this.binanceSpot.getLotSizeFilter(symbol);
    const baseAsset = pairFil.ok
      ? pairFil.baseAsset
      : symbol.replace(/USDT$|BUSD$|FDUSD$/, '') || 'SOL';

    const spotAsc = await this.loadSpotExecutedAsc();
    const recent = await this.prisma.orderIntent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const out: string[] = ['📜 Последние сделки', ''];
    if (recent.length === 0) {
      out.push('—');
      return out.join('\n');
    }
    const rows = this.ordersToHistoryRows(recent, spotAsc, baseAsset);
    const lines = buildTelegramStatsHistoryBlocks(rows);
    for (const line of lines) out.push(line);
    return out.join('\n');
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

  private computeSpotTradeAnalytics(
    rows: Array<{ id: string; createdAt: Date; payload: unknown }>,
  ): {
    agg: {
      buyCount: number;
      sellCount: number;
      profitFromSellsUsdt: number;
    };
    winningSells: number;
    losingSells: number;
    streakCount: number;
    streakKind: 'win' | 'loss' | null;
  } {
    let buyCount = 0;
    let sellCount = 0;
    let profitFromSellsUsdt = 0;
    let winningSells = 0;
    let losingSells = 0;
    const seq: (number | null)[] = [];
    for (const r of rows) {
      const p = r.payload as SpotLivePayload | null;
      if (!p?.spot?.side || !p.exchangeResponse) continue;
      if (p.spot.side === 'BUY') {
        buyCount++;
      } else if (p.spot.side === 'SELL') {
        sellCount++;
        const rp = p.roundtrip?.realizedPnlUsdtEstimate;
        if (rp != null && Number.isFinite(rp)) {
          profitFromSellsUsdt += rp;
          seq.push(rp);
          if (rp > 0) winningSells++;
          else if (rp < 0) losingSells++;
        } else {
          seq.push(null);
        }
      }
    }
    let streakCount = 0;
    let streakKind: 'win' | 'loss' | null = null;
    for (let i = seq.length - 1; i >= 0; i--) {
      const v = seq[i];
      if (v == null || v === 0) break;
      const w = v > 0;
      if (streakKind == null) {
        streakKind = w ? 'win' : 'loss';
        streakCount = 1;
      } else if ((streakKind === 'win') === w) {
        streakCount++;
      } else break;
    }
    return {
      agg: { buyCount, sellCount, profitFromSellsUsdt },
      winningSells,
      losingSells,
      streakCount,
      streakKind,
    };
  }

  private ordersToHistoryRows(
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
    const idxMap = new Map(spotAsc.map((r, i) => [r.id, i]));
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
          rows.push({
            kind: 'spot_buy',
            at: r.createdAt,
            baseQty,
            quoteQty,
            avgPrice: quoteQty / baseQty,
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
          const idx = idxMap.get(r.id);
          const holdMs = idx != null ? this.sellHoldMs(spotAsc, idx) : null;
          rows.push({
            kind: 'spot_sell',
            at: r.createdAt,
            baseQty,
            quoteQty,
            avgPrice: quoteQty / baseQty,
            baseAsset,
            quoteAsset: qa,
            exitKind: p?.roundtrip?.exitKind ?? null,
            realizedPnlUsdt: p?.roundtrip?.realizedPnlUsdtEstimate ?? null,
            holdMs,
          });
          continue;
        }
      }
      const p = r.payload as SpotLivePayload | null;
      const t = r.createdAt.toISOString().slice(0, 16).replace('T', ' ');
      const err = p?.error ? ` · ${p.error}` : '';
      rows.push({
        kind: 'other',
        line: `• ${t} · ${r.provider}/${r.status}${err}`,
      });
    }
    return rows;
  }

  private sellHoldMs(
    asc: Array<{ createdAt: Date; payload: unknown }>,
    sellIdx: number,
  ): number | null {
    for (let i = sellIdx - 1; i >= 0; i--) {
      const p = asc[i].payload as SpotLivePayload | null;
      if (p?.spot?.side !== 'BUY' || !p.exchangeResponse) continue;
      const { baseQty } = parseSpotExchangeFill(p.exchangeResponse);
      if (!Number.isFinite(baseQty) || baseQty <= 0) continue;
      return asc[sellIdx].createdAt.getTime() - asc[i].createdAt.getTime();
    }
    return null;
  }
}

function parseFill(data: Record<string, unknown>): {
  executedQty: number;
  cumQuote: number;
} {
  const { baseQty, quoteQty } = parseSpotExchangeFill(data);
  return { executedQty: baseQty, cumQuote: quoteQty };
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const s = n.toFixed(8).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
}

function fmtPnl(v: number, baseline: number | null): string {
  const sign = v >= 0 ? '+' : '';
  const abs = `${sign}${fmtStatsNumber(v, 2, 2)}$`;
  if (baseline && baseline > 0 && Number.isFinite(v)) {
    const pct = (v / baseline) * 100;
    return `${abs} (${sign}${pct.toFixed(2)}%)`;
  }
  return abs;
}

function fmtSignedPct(abs: number, pct: number): string {
  const sign = abs >= 0 ? '+' : '';
  const absStr = Number.isFinite(abs)
    ? `${sign}${fmtStatsNumber(abs, 2, 2)}$`
    : '—';
  if (!Number.isFinite(pct)) return absStr;
  return `${absStr} (${sign}${pct.toFixed(2)}%)`;
}

// Экспорт утилит формата для других модулей
export { fmtMoney, fmtQty, fmtSignedPct };
export type { TelegramStatsHistoryRow };
