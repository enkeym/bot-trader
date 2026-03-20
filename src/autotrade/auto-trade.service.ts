import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AuditService } from '../audit/audit.service';
import { SimulationService } from '../order/simulation.service';
import { PrismaService } from '../prisma/prisma.service';

const BOT_STATE_ID = 'default';

@Injectable()
export class AutoTradeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradeService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly simulation: SimulationService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.prisma.botState.upsert({
      where: { id: BOT_STATE_ID },
      create: { id: BOT_STATE_ID, autoTradeEnabled: false },
      update: {},
    });
    const ms = this.config.get<number>('autoTrade.intervalMs') ?? 180_000;
    this.intervalRef = setInterval(() => void this.tick(), ms);
    this.logger.log(`Auto-trade tick каждые ${ms} ms (бумага / DRY_RUN)`);
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  async getState() {
    return this.prisma.botState.findUniqueOrThrow({
      where: { id: BOT_STATE_ID },
    });
  }

  async setEnabled(enabled: boolean, notifyChatId?: string) {
    return this.prisma.botState.update({
      where: { id: BOT_STATE_ID },
      data: {
        autoTradeEnabled: enabled,
        ...(notifyChatId != null ? { notifyChatId } : {}),
      },
    });
  }

  private async tick() {
    let enabled = false;
    try {
      const st = await this.getState();
      enabled = st.autoTradeEnabled;
    } catch (e) {
      this.logger.warn(`BotState: ${e}`);
      return;
    }
    if (!enabled) return;

    const maxNotional =
      this.config.get<number>('strategy.maxNotionalUsdt') ?? 500;
    const dryRun = this.config.get<boolean>('dryRun') ?? true;

    if (!dryRun) {
      await this.audit.log('warn', 'autotrade_skipped_not_dry_run', {});
      return;
    }

    try {
      const res = await this.simulation.runPairSimulation(maxNotional);
      if (!res.ok || !res.orderCreated || !res.order) return;

      const chatId =
        this.config.get<string>('telegramAlertChatId') ??
        (await this.getState()).notifyChatId;
      if (!chatId) return;

      const profit =
        res.estimatedProfitUsdt != null
          ? `~${res.estimatedProfitUsdt} USDT (оценка)`
          : '—';
      await this.sendTelegram(
        chatId,
        [
          '[Авто-симуляция] новая запись SIMULATED',
          `OrderIntent: ${res.order.id}`,
          `Прибыль (бумага): ${profit}`,
          'Реальной сделки на Binance нет (DRY_RUN).',
        ].join('\n'),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`autotrade tick: ${msg}`);
    }
  }

  private async sendTelegram(chatId: string, text: string) {
    const token = this.config.get<string>('telegramBotToken');
    if (!token) return;
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text },
      { timeout: 15_000 },
    );
  }
}
