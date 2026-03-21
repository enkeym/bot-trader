import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinanceModule } from '../binance/binance.module';
import { RedisModule } from '../redis/redis.module';
import { MarketStatsService } from './market-stats.service';

@Module({
  imports: [ConfigModule, BinanceModule, RedisModule],
  providers: [MarketStatsService],
  exports: [MarketStatsService],
})
export class MarketModule {}
