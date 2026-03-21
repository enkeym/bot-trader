import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isWithinTradingScheduleUtc,
  parseTradingDaysUtc,
  parseTradingWindowUtc,
} from '../config/trading-schedule.util';
import { PrismaService } from '../prisma/prisma.service';

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
}
