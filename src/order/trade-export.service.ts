import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { parseSpotExchangeFill } from './balance-telegram.format';
import type { SimPayload, SpotLivePayload } from './simulation.service';

export type TradeExportMeta = {
  generatedAt: string;
  spotSymbol: string;
  spotStrategy: 'fixed_side' | 'roundtrip';
  spotBaseUrl: string;
  rowCount: number;
  truncated: boolean;
};

export type NormalizedTradeRow = {
  ts: string;
  id: string;
  idempotencyKey: string;
  provider: string;
  side: string;
  status: string;
  symbol?: string;
  spotSide?: 'BUY' | 'SELL';
  /** Сумма в валюте котировки пары */
  quoteQty?: number;
  baseQty?: number;
  p2pGrossSpreadPercent?: number;
  p2pNetSpreadPercent?: number;
  estimatedStrategyPnlUsdt?: number | null;
  roundtrip?: Record<string, unknown>;
  exitKind?: string;
  exchangeOrderId?: string | number | null;
  error?: string;
};

export type TradeExportBundle = {
  meta: TradeExportMeta;
  trades: NormalizedTradeRow[];
};

const DEFAULT_MAX_ROWS = 5000;

@Injectable()
export class TradeExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async buildBundle(
    maxRows: number = DEFAULT_MAX_ROWS,
  ): Promise<TradeExportBundle> {
    const spotSymbol =
      this.config.get<string>('binance.spotSymbol') ?? 'SOLUSDT';
    const spotStrategy =
      this.config.get<'fixed_side' | 'roundtrip'>('binance.spotStrategy') ??
      'fixed_side';
    const spotBaseUrl =
      this.config.get<string>('binance.spotBaseUrl') ??
      'https://api.binance.com';
    const rows = await this.prisma.orderIntent.findMany({
      where: {
        provider: { in: ['binance', 'binance_spot'] },
      },
      orderBy: { createdAt: 'asc' },
      take: maxRows + 1,
    });

    const truncated = rows.length > maxRows;
    const slice = truncated ? rows.slice(0, maxRows) : rows;

    const trades = slice.map((r) => this.normalizeRow(r, spotSymbol));

    return {
      meta: {
        generatedAt: new Date().toISOString(),
        spotSymbol,
        spotStrategy,
        spotBaseUrl,
        rowCount: trades.length,
        truncated,
      },
      trades,
    };
  }

  /** JSON с отступами — удобно для ИИ и diff. */
  buildJsonPretty(bundle: TradeExportBundle): string {
    return JSON.stringify(bundle, null, 2);
  }

  /** NDJSON: одна сделка на строку + первая строка meta. */
  buildNdjson(bundle: TradeExportBundle): string {
    const lines = [
      JSON.stringify({ _type: 'meta', ...bundle.meta }),
      ...bundle.trades.map((t) => JSON.stringify(t)),
    ];
    return lines.join('\n');
  }

  private normalizeRow(
    r: {
      id: string;
      idempotencyKey: string;
      provider: string;
      side: string;
      status: string;
      payload: unknown;
      createdAt: Date;
    },
    defaultSymbol: string,
  ): NormalizedTradeRow {
    const base: NormalizedTradeRow = {
      ts: r.createdAt.toISOString(),
      id: r.id,
      idempotencyKey: r.idempotencyKey,
      provider: r.provider,
      side: r.side,
      status: r.status,
    };

    if (r.provider === 'binance' && r.status === 'SIMULATED') {
      const p = r.payload as SimPayload | null;
      if (p?.roundtrip) {
        return {
          ...base,
          symbol: defaultSymbol,
          spotSide: p.roundtrip.chosenSide,
          roundtrip: {
            markPrice: p.roundtrip.markPrice,
            trackedBtcAfter: p.roundtrip.trackedBtcAfter,
            avgEntryUsdtAfter: p.roundtrip.avgEntryUsdtAfter,
            takeProfitPercent: p.roundtrip.takeProfitPercent,
            realizedPnlUsdtEstimate:
              p.roundtrip.realizedPnlUsdtEstimate ?? null,
          },
          p2pGrossSpreadPercent: p.grossSpreadPercent,
          p2pNetSpreadPercent: p.netSpreadPercent,
          estimatedStrategyPnlUsdt: p.estimatedProfitUsdt,
        };
      }
      return {
        ...base,
        p2pGrossSpreadPercent: p?.grossSpreadPercent,
        p2pNetSpreadPercent: p?.netSpreadPercent,
        estimatedStrategyPnlUsdt: p?.estimatedProfitUsdt ?? null,
      };
    }

    if (r.provider === 'binance_spot') {
      const p = r.payload as SpotLivePayload | null;
      const ex = p?.exchangeResponse;
      const { baseQty, quoteQty } = parseSpotExchangeFill(ex);
      const rawOid = ex && typeof ex === 'object' ? ex['orderId'] : undefined;
      const exchangeOrderId =
        typeof rawOid === 'string' || typeof rawOid === 'number'
          ? rawOid
          : null;
      return {
        ...base,
        symbol: p?.spot?.symbol ?? defaultSymbol,
        spotSide: p?.spot?.side,
        quoteQty: Number.isFinite(quoteQty) ? quoteQty : undefined,
        baseQty: Number.isFinite(baseQty) ? baseQty : undefined,
        p2pGrossSpreadPercent: p?.p2pSpreadContext?.grossSpreadPercent,
        p2pNetSpreadPercent: p?.p2pSpreadContext?.netSpreadPercent,
        estimatedStrategyPnlUsdt: p?.estimatedStrategyPnlUsdt ?? null,
        roundtrip: p?.roundtrip
          ? {
              ...p.roundtrip,
              exitKind: p.roundtrip.exitKind,
            }
          : undefined,
        exitKind: p?.roundtrip?.exitKind,
        exchangeOrderId,
        error: p?.error,
      };
    }

    return base;
  }
}
