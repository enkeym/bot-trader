import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceModule } from '../binance/binance.module';
import { MarketModule } from '../market/market.module';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { OrderIntentService } from './order-intent.service';
import { SimulationService } from './simulation.service';
import { TradeExportService } from './trade-export.service';

@Module({
  imports: [
    ConfigModule,
    StrategyModule,
    RiskModule,
    BinanceModule,
    MarketModule,
  ],
  providers: [OrderIntentService, SimulationService, TradeExportService],
  exports: [OrderIntentService, SimulationService, TradeExportService],
})
export class OrderModule {}
