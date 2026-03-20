import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RiskCheckInput {
  grossSpreadPercent: number;
  notionalUsdt: number;
}

@Injectable()
export class RiskService {
  constructor(private readonly config: ConfigService) {}

  get minSpreadPercent(): number {
    return this.config.get<number>('strategy.minSpreadPercent') ?? 0.15;
  }

  get maxNotionalUsdt(): number {
    return this.config.get<number>('strategy.maxNotionalUsdt') ?? 500;
  }

  get dailyMaxLossUsdt(): number {
    return this.config.get<number>('strategy.dailyMaxLossUsdt') ?? 50;
  }

  /** Разрешить сигнал (до банковского шага). */
  allowSignal(input: RiskCheckInput): boolean {
    if (input.grossSpreadPercent < this.minSpreadPercent) return false;
    if (input.notionalUsdt > this.maxNotionalUsdt) return false;
    return true;
  }
}
