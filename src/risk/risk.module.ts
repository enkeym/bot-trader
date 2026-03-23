import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceModule } from '../binance/binance.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RiskService } from './risk.service';

@Module({
  imports: [ConfigModule, PrismaModule, BinanceModule],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
