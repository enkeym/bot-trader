import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type {
  P2PProvider,
  P2pMarketSnapshot,
  P2pQuote,
} from '../interfaces/p2p-provider.interface';

const BINANCE_P2P_SEARCH =
  'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

/** Как в веб-клиенте Binance: без payTypes/countries API часто отдаёт пустой data[] с нехарактерных IP. */
const P2P_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  clienttype: 'web',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
} as const;

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
      const rubNote =
        f.toUpperCase() === 'RUB'
          ? ' Для FIAT=RUB стакан с VPS/датацентра за пределами РФ у Binance часто пустой — попробуйте FIAT=USD или EUR, либо резидентский IP/VPN под регион RUB.'
          : '';
      hint =
        'Binance ответил успешно, но объявлений нет (data:[]). Проверьте ASSET/FIAT на p2p.binance.com; с «чужого» IP часто пусто для отдельных фиатов.' +
        rubNote +
        ' Либо смените FIAT (USD, EUR), либо сеть/VPN.';
      this.logger.warn(
        `Binance P2P: пустой стакан ${a}/${f} (обе стороны). code=000000, data=[].`,
      );
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
      payTypes: [] as string[],
      countries: [] as string[],
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
        headers: { ...P2P_HEADERS },
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
