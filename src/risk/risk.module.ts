import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RiskService } from './risk.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [RiskService],
  exports: [RiskService],
})
export class RiskModule {}
