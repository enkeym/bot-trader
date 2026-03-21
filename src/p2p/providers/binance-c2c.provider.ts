import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type {
  P2PProvider,
  P2pMarketSnapshot,
  P2pQuote,
} from '../interfaces/p2p-provider.interface';

const BINANCE_P2P_SEARCH =
  'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

interface BinanceAdvPayload {
  advNo: string;
  price: string;
  minSingleTransAmount: string;
  maxSingleTransAmount: string;
}

interface BinanceAdvItem {
  adv: BinanceAdvPayload;
}

@Injectable()
export class BinanceC2cProvider implements P2PProvider {
  readonly name = 'binance';

  private readonly logger = new Logger(BinanceC2cProvider.name);

  async getMarketSnapshot(
    asset: string,
    fiat: string,
  ): Promise<P2pMarketSnapshot> {
    const a = asset.trim();
    const f = fiat.trim();
    const [buyBook, sellBook] = await Promise.all([
      this.search(a, f, 'BUY'),
      this.search(a, f, 'SELL'),
    ]);

    const buyTop = buyBook.slice(0, 10);
    const sellTop = sellBook.slice(0, 10);

    const bestBuyUsdtPrice =
      buyTop.length > 0 ? Math.min(...buyTop.map((q) => q.price)) : null;
    const bestSellUsdtPrice =
      sellTop.length > 0 ? Math.max(...sellTop.map((q) => q.price)) : null;

    let hint: string | undefined;
    if (buyTop.length === 0 && sellTop.length === 0) {
      hint =
        'Binance ответил успешно, но объявлений нет (data:[]). Так бывает для выбранной пары ASSET/FIAT, региональных ограничений P2P или отсутствия контрагентов. Проверьте пару в .env (FIAT/ASSET), другой FIAT (USD, EUR) или сеть/VPN.';
    }

    return {
      asset: a,
      fiat: f,
      bestBuyUsdtPrice,
      bestSellUsdtPrice,
      buyTop,
      sellTop,
      hint,
    };
  }

  private async search(
    asset: string,
    fiat: string,
    tradeType: 'BUY' | 'SELL',
  ): Promise<P2pQuote[]> {
    const body = {
      asset,
      fiat,
      tradeType,
      page: 1,
      rows: 20,
      publisherType: null,
    };

    try {
      const { data } = await axios.post<{
        code?: string;
        data?: BinanceAdvItem[];
        message?: string;
        success?: boolean;
      }>(BINANCE_P2P_SEARCH, body, {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (compatible; TraderBot/1.0; +https://github.com/)',
        },
      });

      if (data?.code != null && data.code !== '000000') {
        this.logger.warn(
          `Binance P2P code=${data.code} message=${data.message ?? ''}`,
        );
      }

      const rows = Array.isArray(data?.data) ? data.data : [];
      if (rows.length === 0 && data?.message) {
        this.logger.warn(`Binance P2P empty: ${data.message}`);
      }

      return rows
        .filter((row): row is BinanceAdvItem => row?.adv != null)
        .map((row) => this.mapAdv(row.adv))
        .filter((q) => !Number.isNaN(q.price));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Binance P2P search failed: ${msg}`);
      throw err;
    }
  }

  private mapAdv(adv: BinanceAdvPayload): P2pQuote {
    return {
      advNo: adv.advNo,
      price: parseFloat(adv.price),
      minAmount: parseFloat(adv.minSingleTransAmount),
      maxAmount: parseFloat(adv.maxSingleTransAmount),
    };
  }
}
