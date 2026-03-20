import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
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

@Injectable()
export class SimulationService {
  constructor(
    private readonly spread: SpreadService,
    private readonly risk: RiskService,
    private readonly orders: OrderIntentService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
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

    await this.audit.log('warn', 'dry_run_false_not_implemented', {
      message:
        'Реальные SAPI-вызовы не включены в MVP; оставьте DRY_RUN=true или реализуйте подписанный клиент.',
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
}
