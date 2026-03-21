import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceSpotService } from './binance-spot.service';

@Module({
  imports: [ConfigModule],
  providers: [BinanceSpotService],
  exports: [BinanceSpotService],
})
export class BinanceModule {}
