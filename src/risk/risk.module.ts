import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RiskService } from './risk.service';

@Module({
  imports: [ConfigModule],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
