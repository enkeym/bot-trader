import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import { SpreadService } from '../strategy/spread.service';
import { TelegramService } from './telegram.service';

const CACHE_KEY = 'spread:last_alert_ts';

/**
 * Периодическая проверка спреда; при сильном отклонении — сообщение в TELEGRAM_ALERT_CHAT_ID (не чаще 1 раз / 10 мин).
 */
@Injectable()
export class SpreadMonitorService {
  private readonly logger = new Logger(SpreadMonitorService.name);
  private lastMemoryAlert = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly spread: SpreadService,
    private readonly telegram: TelegramService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSpread() {
    if (!this.config.get<boolean>('telegramSpreadAlertsEnabled')) {
      return;
    }
    const chatId = this.config.get<string>('telegramAlertChatId');
    if (!chatId) return;

    const asset = this.config.get<string>('market.asset') ?? 'USDT';
    const fiat = this.config.get<string>('market.fiat') ?? 'USD';
    const min = this.config.get<number>('strategy.minSpreadPercent') ?? 0.15;
    const ev = await this.spread.evaluate(asset, fiat);
    const net = ev.netSpreadPercent;
    if (net == null) return;
    if (net < min * 2) return;

    const now = Date.now();
    if (this.redis.getClient()) {
      const last = await this.redis.getJson<number>(CACHE_KEY);
      if (last != null && now - last < 10 * 60 * 1000) return;
      await this.redis.setJson(CACHE_KEY, now, 15 * 60);
    } else if (now - this.lastMemoryAlert < 10 * 60 * 1000) {
      return;
    } else {
      this.lastMemoryAlert = now;
    }

    const msg = [
      `Спред ${asset}/${fiat}: чистый ${net.toFixed(3)}% (порог x2 от min ${min}%)`,
      `buy ${ev.snapshot.bestBuyUsdtPrice}, sell ${ev.snapshot.bestSellUsdtPrice}`,
    ].join('\n');

    try {
      await this.telegram.sendAlert(msg);
    } catch (e) {
      this.logger.warn(`sendAlert failed: ${e}`);
    }
  }
}
