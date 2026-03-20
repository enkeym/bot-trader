import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceC2cProvider } from './providers/binance-c2c.provider';
import { P2pService } from './p2p.service';

@Module({
  imports: [ConfigModule],
  providers: [BinanceC2cProvider, P2pService],
  exports: [P2pService, BinanceC2cProvider],
})
export class P2pModule {}
