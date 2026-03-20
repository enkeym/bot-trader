import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { P2pService } from '../p2p/p2p.service';
import type { P2pMarketSnapshot } from '../p2p/interfaces/p2p-provider.interface';

export interface SpreadEvaluation {
  snapshot: P2pMarketSnapshot;
  /** Грубый спред: sell - buy в процентах от buy. */
  grossSpreadPercent: number | null;
  /** После учёта taker fee из конфига. */
  netSpreadPercent: number | null;
}

@Injectable()
export class SpreadService {
  constructor(
    private readonly p2p: P2pService,
    private readonly config: ConfigService,
  ) {}

  async evaluate(asset: string, fiat: string): Promise<SpreadEvaluation> {
    let snapshot: P2pMarketSnapshot;
    try {
      snapshot = await this.p2p.getSnapshot(asset, fiat);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      snapshot = {
        asset,
        fiat,
        bestBuyUsdtPrice: null,
        bestSellUsdtPrice: null,
        buyTop: [],
        sellTop: [],
        hint: `Запрос к Binance не выполнен: ${msg}`,
      };
      return {
        snapshot,
        grossSpreadPercent: null,
        netSpreadPercent: null,
      };
    }

    const { bestBuyUsdtPrice, bestSellUsdtPrice } = snapshot;

    if (
      bestBuyUsdtPrice == null ||
      bestSellUsdtPrice == null ||
      bestBuyUsdtPrice <= 0
    ) {
      return {
        snapshot,
        grossSpreadPercent: null,
        netSpreadPercent: null,
      };
    }

    const grossSpreadPercent =
      ((bestSellUsdtPrice - bestBuyUsdtPrice) / bestBuyUsdtPrice) * 100;

    const fee = this.config.get<number>('strategy.takerFeePercent') ?? 0;
    const netSpreadPercent = grossSpreadPercent - 2 * fee;

    return {
      snapshot,
      grossSpreadPercent,
      netSpreadPercent,
    };
  }
}
