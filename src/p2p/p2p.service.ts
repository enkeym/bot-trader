import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinanceC2cProvider } from './providers/binance-c2c.provider';
import type {
  P2PProvider,
  P2pMarketSnapshot,
} from './interfaces/p2p-provider.interface';

@Injectable()
export class P2pService {
  private readonly provider: P2PProvider;

  constructor(
    private readonly config: ConfigService,
    private readonly binance: BinanceC2cProvider,
  ) {
    const name = this.config.get<string>('p2pProvider') ?? 'binance';
    if (name !== 'binance') {
      throw new Error(
        `Unsupported P2P_PROVIDER: ${name} (only "binance" in MVP)`,
      );
    }
    this.provider = this.binance;
  }

  getProvider(): P2PProvider {
    return this.provider;
  }

  getSnapshot(asset: string, fiat: string): Promise<P2pMarketSnapshot> {
    return this.provider.getMarketSnapshot(asset, fiat);
  }
}
