import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceModule } from '../binance/binance.module';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { OrderIntentService } from './order-intent.service';
import { SimulationService } from './simulation.service';

@Module({
  imports: [ConfigModule, StrategyModule, RiskModule, BinanceModule],
  providers: [OrderIntentService, SimulationService],
  exports: [OrderIntentService, SimulationService],
})
export class OrderModule {}
