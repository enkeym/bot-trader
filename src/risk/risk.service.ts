import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isWithinTradingScheduleUtc,
  parseTradingDaysUtc,
  parseTradingWindowUtc,
} from '../config/trading-schedule.util';
import { BinanceSpotService } from '../binance/binance-spot.service';
import { PrismaService } from '../prisma/prisma.service';

export type AutotradeCircuitReason = 'equity_drawdown_vs_baseline';

export interface AutotradeCircuitBlocked {
  ok: false;
  reason: AutotradeCircuitReason;
}

export interface RiskCheckInput {
  grossSpreadPercent: number;
  notionalUsdt: number;
}

/** Payload фрагмент для подсчёта дневного убытка по SELL Spot */
type SpotPayloadForLoss = {
  roundtrip?: { realizedPnlUsdtEstimate?: number | null };
};

function utcDayBounds(d: Date): { start: Date; end: Date } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const start = new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, day + 1, 0, 0, 0, 0));
  return { start, end };
}

@Injectable()
export class RiskService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly binanceSpot: BinanceSpotService,
  ) {}

  get minSpreadPercent(): number {
    return this.config.get<number>('strategy.minSpreadPercent') ?? 0.15;
  }

  get maxNotionalUsdt(): number {
    return this.config.get<number>('strategy.maxNotionalUsdt') ?? 500;
  }

  get dailyMaxLossUsdt(): number {
    return this.config.get<number>('strategy.dailyMaxLossUsdt') ?? 50;
  }

  get maxDailySpotTrades(): number {
    return this.config.get<number>('strategy.maxDailySpotTrades') ?? 0;
  }

  private getTradingWindowParsed() {
    const raw = this.config.get<string>('autoTrade.tradingWindowUtc') ?? '';
    return parseTradingWindowUtc(raw);
  }

  private getTradingDaysParsed() {
    const raw = this.config.get<string>('autoTrade.tradingDaysUtc') ?? '';
    return parseTradingDaysUtc(raw);
  }

  /**
   * Разрешить сигнал (до банковского шага).
   * Дневной стоп по реализованному убытку Spot — в `checkAutotradeScheduleAndDailyLimits`.
   */
  allowSignal(input: RiskCheckInput): boolean {
    if (input.grossSpreadPercent < this.minSpreadPercent) return false;
    if (input.notionalUsdt > this.maxNotionalUsdt) return false;
    return true;
  }

  /** Только UTC-расписание (без БД). */
  isWithinAutotradeTradingSchedule(now: Date = new Date()): boolean {
    return isWithinTradingScheduleUtc(
      now,
      this.getTradingWindowParsed(),
      this.getTradingDaysParsed(),
    );
  }

  /**
   * Лимиты по БД: число исполненных Spot за сутки UTC и сумма отрицательных
   * `realizedPnlUsdtEstimate` на SELL (roundtrip).
   */
  async checkAutotradeDailyLimits(
    now: Date = new Date(),
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'max_daily_spot_trades' | 'daily_max_loss_usdt' }
  > {
    const maxTrades = this.maxDailySpotTrades;
    const maxLoss = this.dailyMaxLossUsdt;

    const { start, end } = utcDayBounds(now);

    if (maxTrades > 0) {
      const count = await this.prisma.orderIntent.count({
        where: {
          provider: 'binance_spot',
          status: 'EXECUTED',
          createdAt: { gte: start, lt: end },
        },
      });
      if (count >= maxTrades) {
        return { ok: false, reason: 'max_daily_spot_trades' };
      }
    }

    if (maxLoss > 0) {
      const sells = await this.prisma.orderIntent.findMany({
        where: {
          provider: 'binance_spot',
          status: 'EXECUTED',
          side: { contains: 'SELL' },
          createdAt: { gte: start, lt: end },
        },
        select: { payload: true },
      });
      let lossSum = 0;
      for (const row of sells) {
        const p = row.payload as SpotPayloadForLoss | null;
        const est = p?.roundtrip?.realizedPnlUsdtEstimate;
        if (est != null && typeof est === 'number' && est < 0) {
          lossSum += -est;
        }
      }
      if (lossSum >= maxLoss) {
        return { ok: false, reason: 'daily_max_loss_usdt' };
      }
    }

    return { ok: true };
  }

  /**
   * Только просадка эквити от baseline (серия убыточных SELL обрабатывается
   * в AutoTradeService: выключение флага автоторговли).
   */
  async checkAutotradeCircuitBreakers(
    _now: Date = new Date(),
  ): Promise<{ ok: true } | AutotradeCircuitBlocked> {
    return this.checkEquityDrawdownVsBaseline();
  }

  /**
   * Последние N исполненных Spot SELL с отрицательным realizedPnlUsdtEstimate подряд.
   * `MAX_CONSECUTIVE_LOSS_SELLS=0` — всегда false.
   */
  async hasConsecutiveLossStreak(): Promise<boolean> {
    const n = this.config.get<number>('strategy.maxConsecutiveLossSells') ?? 0;
    if (!(n > 0)) return false;

    const rows = await this.prisma.orderIntent.findMany({
      where: {
        provider: 'binance_spot',
        status: 'EXECUTED',
        side: { contains: 'SELL' },
      },
      orderBy: { createdAt: 'desc' },
      take: n,
      select: { payload: true },
    });

    if (rows.length < n) return false;

    for (const row of rows) {
      const est = (row.payload as SpotPayloadForLoss | null)?.roundtrip
        ?.realizedPnlUsdtEstimate;
      if (est == null || typeof est !== 'number' || est >= 0) {
        return false;
      }
    }
    return true;
  }

  private async checkEquityDrawdownVsBaseline(): Promise<
    { ok: true } | AutotradeCircuitBlocked
  > {
    const baseline =
      this.config.get<number | null>('stats.equityBaselineQuote') ?? null;
    const maxDd =
      this.config.get<number>('autoTrade.maxEquityDrawdownPercent') ?? 0;
    if (baseline == null || baseline <= 0 || !(maxDd > 0)) {
      return { ok: true };
    }

    const symbol = this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const tick = await this.binanceSpot.getTickerPrice(symbol);
    if (!tick.ok) return { ok: true };

    const pairFil = await this.binanceSpot.getLotSizeFilter(symbol);
    if (!pairFil.ok) return { ok: true };

    const bal = await this.binanceSpot.getAccountBalances();
    if (!bal.ok) return { ok: true };

    const { quoteAsset, baseAsset } = pairFil;
    const qRow = bal.balances.find((b) => b.asset === quoteAsset);
    const bRow = bal.balances.find((b) => b.asset === baseAsset);
    const quoteTot =
      parseFloat(qRow?.free ?? '0') + parseFloat(qRow?.locked ?? '0');
    const baseTot =
      parseFloat(bRow?.free ?? '0') + parseFloat(bRow?.locked ?? '0');
    const equity = quoteTot + baseTot * tick.price;
    const floor = baseline * (1 - maxDd / 100);
    if (equity < floor) {
      return { ok: false, reason: 'equity_drawdown_vs_baseline' };
    }
    return { ok: true };
  }
}
