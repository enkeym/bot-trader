import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { OrderIntentService } from './order-intent.service';
import { SimulationService } from './simulation.service';

@Module({
  imports: [ConfigModule, StrategyModule, RiskModule],
  providers: [OrderIntentService, SimulationService],
  exports: [OrderIntentService, SimulationService],
})
export class OrderModule {}
