import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Опциональный Redis: при отсутствии REDIS_URL клиент не создаётся (локальная разработка без кэша).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('redisUrl')?.trim();
    if (!url) {
      this.logger.warn('REDIS_URL not set — distributed locks/cache disabled');
      return;
    }
    this.client = new Redis(url, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectTimeout: 10_000,
      retryStrategy: (times) => {
        if (times > 8) {
          this.logger.warn(
            'Redis: прекращаем переподключения. Проверьте, что контейнер запущен: docker compose up -d redis',
          );
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    });
    this.client.on('error', (err) => {
      this.logger.warn(`Redis: ${err.message}`);
    });
    try {
      await this.client.ping();
      this.logger.log(
        'Redis: подключение OK (дедуп Telegram update_id между процессами)',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Redis: старт без рабочего соединения (${msg}). ` +
          'Telegram дедуп по update_id только внутри одного процесса — при двух инстансах с одним токеном ответы продублируются. ' +
          'Для npm на хосте: свой Redis на localhost, override compose с ports или оставьте REDIS_URL пустым — см. README.',
      );
    }
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  getClient(): Redis | null {
    return this.client;
  }

  async setJson(key: string, value: unknown, ttlSec: number) {
    if (!this.client) return;
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSec);
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    const raw = await this.client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }
}
