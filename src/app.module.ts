import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { OrderModule } from './order/order.module';
import { P2pModule } from './p2p/p2p.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RiskModule } from './risk/risk.module';
import { StrategyModule } from './strategy/strategy.module';
import { TelegramModule } from './telegram/telegram.module';
import { TonModule } from './ton/ton.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    AuditModule,
    P2pModule,
    RiskModule,
    StrategyModule,
    OrderModule,
    TonModule,
    TelegramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
