import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AutoTradeModule } from '../autotrade/auto-trade.module';
import { MarketModule } from '../market/market.module';
import { OrderModule } from '../order/order.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [ConfigModule, OrderModule, AutoTradeModule, MarketModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
