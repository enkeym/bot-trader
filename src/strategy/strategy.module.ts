import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceModule } from '../binance/binance.module';
import { RegimeService } from './regime.service';
import { TaService } from './ta.service';

@Module({
  imports: [ConfigModule, BinanceModule],
  providers: [TaService, RegimeService],
  exports: [TaService, RegimeService],
})
export class StrategyModule {}
