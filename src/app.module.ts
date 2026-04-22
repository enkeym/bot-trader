import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { OrderModule } from './order/order.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RiskModule } from './risk/risk.module';
import { StrategyModule } from './strategy/strategy.module';
import { TelegramModule } from './telegram/telegram.module';

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
    RiskModule,
    StrategyModule,
    AiModule,
    OrderModule,
    TelegramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
