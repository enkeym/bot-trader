import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { BinanceModule } from '../binance/binance.module';
import { OrderModule } from '../order/order.module';
import { RiskModule } from '../risk/risk.module';
import { AutoTradeService } from './auto-trade.service';

@Module({
  imports: [ConfigModule, OrderModule, AuditModule, BinanceModule, RiskModule],
  providers: [AutoTradeService],
  exports: [AutoTradeService],
})
export class AutoTradeModule {}
