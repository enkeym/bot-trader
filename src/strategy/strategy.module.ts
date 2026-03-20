import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { P2pModule } from '../p2p/p2p.module';
import { SpreadService } from './spread.service';

@Module({
  imports: [ConfigModule, P2pModule],
  providers: [SpreadService],
  exports: [SpreadService],
})
export class StrategyModule {}
