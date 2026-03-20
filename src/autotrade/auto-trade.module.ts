import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { OrderModule } from '../order/order.module';
import { AutoTradeService } from './auto-trade.service';

@Module({
  imports: [ConfigModule, OrderModule, AuditModule],
  providers: [AutoTradeService],
  exports: [AutoTradeService],
})
export class AutoTradeModule {}
