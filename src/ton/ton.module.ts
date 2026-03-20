import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TonController } from './ton.controller';
import { TonService } from './ton.service';

@Module({
  imports: [ConfigModule],
  controllers: [TonController],
  providers: [TonService],
  exports: [TonService],
})
export class TonModule {}
