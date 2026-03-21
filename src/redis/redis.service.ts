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
      connectTimeout: 15_000,
      retryStrategy: (times) => {
        if (times > 8) {
          this.logger.warn(
            'Redis: прекращаем переподключения. Проверьте: docker compose up -d redis, REDIS_URL (в Docker — redis://redis:6379).',
          );
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    });
    this.client.on('error', (err) => {
      this.logger.warn(`Redis: ${err.message}`);
    });
    const maxAttempts = 25;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.client.ping();
        this.logger.log(
          'Redis: подключение OK (дедуп Telegram update_id между процессами)',
        );
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === maxAttempts) {
          this.logger.error(
            `Redis: не удалось подключиться (${msg}). ` +
              'Telegram дедуп только внутри процесса. Docker: убедитесь, что в compose задан REDIS_URL=redis://redis:6379; локально: redis://127.0.0.1:6379 при пробросе порта или оставьте REDIS_URL пустым — см. README.',
          );
          try {
            await this.client.quit();
          } catch {
            /* ignore */
          }
          this.client = null;
          return;
        }
        this.logger.warn(
          `Redis: попытка ${attempt}/${maxAttempts} (${msg}), повтор через 1 с…`,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
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
