import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinancePublicService } from './binance-public.service';
import { BinanceSpotService } from './binance-spot.service';

@Module({
  imports: [ConfigModule],
  providers: [BinanceSpotService, BinancePublicService],
  exports: [BinanceSpotService, BinancePublicService],
})
export class BinanceModule {}
