import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AutoTradeModule } from '../autotrade/auto-trade.module';
import { MarketModule } from '../market/market.module';
import { OrderModule } from '../order/order.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TonModule } from '../ton/ton.module';
import { SpreadMonitorService } from './spread-monitor.service';
import { TelegramService } from './telegram.service';

@Module({
  imports: [
    ConfigModule,
    StrategyModule,
    OrderModule,
    TonModule,
    AutoTradeModule,
    MarketModule,
  ],
  providers: [TelegramService, SpreadMonitorService],
  exports: [TelegramService],
})
export class TelegramModule {}
