import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, InputFile, Keyboard } from 'grammy';
import { AutoTradeService } from '../autotrade/auto-trade.service';
import { MarketStatsService } from '../market/market-stats.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SimulationService } from '../order/simulation.service';
import { TradeExportService } from '../order/trade-export.service';

const MAX_MSG = 4000;

const BTN_AUTO_ON = '▶️ Включить автоторговлю';
const BTN_AUTO_OFF = '⏹ Выключить автоторговлю';
const BTN_STATS = '📊 Статистика';
const BTN_HISTORY = '📜 История';
const BTN_EXPORT = '📦 Выгрузка JSON';

@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;
  private readonly claimedUpdateIdsLocal = new Set<number>();

  constructor(
    private readonly config: ConfigService,
    private readonly simulation: SimulationService,
    private readonly prisma: PrismaService,
    private readonly autoTrade: AutoTradeService,
    private readonly redis: RedisService,
    private readonly marketStats: MarketStatsService,
    private readonly tradeExport: TradeExportService,
  ) {}

  onApplicationBootstrap() {
    this.logger.log('Telegram: onApplicationBootstrap');
    if (process.env.NODE_ENV === 'test') {
      this.logger.warn('Telegram disabled (NODE_ENV=test)');
      return;
    }
    const token =
      this.config.get<string>('telegramBotToken')?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN пуст — Telegram выключен');
      return;
    }

    const adminIds = this.config.get<string[]>('adminTelegramIds') ?? [];
    if (adminIds.length === 0) {
      this.logger.warn('ADMIN_TELEGRAM_IDS пуст — команды недоступны');
    }
    if (this.bot) {
      this.logger.warn('Telegram: повторный bootstrap — пропуск');
      return;
    }
    this.bot = new Bot(token);

    this.bot.use(async (ctx, next) => {
      const id = ctx.update.update_id;
      const claimed = await this.claimUpdateOnce(id);
      if (!claimed) return;
      await next();
    });

    this.bot.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Telegram: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
    });

    const statsHandler = async (ctx: Context) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const text = await this.simulation.buildTelegramTradingReport();
      await ctx.reply(clip(text), {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    };
    const historyHandler = async (ctx: Context) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const text = await this.simulation.buildTelegramTradingHistoryReport();
      await ctx.reply(clip(text), {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    };

    this.bot.command('start', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      await this.upsertUser(ctx);
      await ctx.reply(
        'Трейдер Binance Spot · /stats /history /market /autotrade',
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    });

    this.bot.command('menu', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      await ctx.reply('Меню:', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot
      .filter(
        (ctx) =>
          ctx.hasCommand('stats') ||
          ctx.hasCommand('статистика') ||
          ctx.hasText(BTN_STATS),
      )
      .use(statsHandler);

    this.bot
      .filter(
        (ctx) =>
          ctx.hasCommand('history') ||
          ctx.hasCommand('история') ||
          ctx.hasText(BTN_HISTORY),
      )
      .use(historyHandler);

    const exportHandler = async (ctx: Context) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const maxRows = 5000;
      const bundle = await this.tradeExport.buildBundle(maxRows);
      const json = this.tradeExport.buildJsonPretty(bundle);
      const buf = Buffer.from(json, 'utf8');
      const name = `trades-export-${bundle.meta.generatedAt.slice(0, 10)}.json`;
      const cap = bundle.meta.truncated
        ? `Усечено до ${maxRows} записей.`
        : `Записей: ${bundle.meta.rowCount}.`;
      await ctx.replyWithDocument(new InputFile(buf, name), {
        caption: cap,
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    };

    this.bot.filter((ctx) => ctx.hasText(BTN_EXPORT)).use(exportHandler);

    this.bot.command('market', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const arg = ctx.message?.text?.trim().split(/\s+/)[1];
      const report = await this.marketStats.getReport(arg);
      if (!report) {
        await ctx.reply('Свечи недоступны (проверьте BINANCE_SPOT_BASE_URL).', {
          reply_markup: await this.mainKeyboardForUser(ctx),
        });
        return;
      }
      await ctx.reply(clip(this.marketStats.formatTelegram(report)), {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.hears(BTN_AUTO_ON, async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
      await this.autoTrade.setEnabled(true, chatId);
      await ctx.reply('▶️ Работает', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.hears(BTN_AUTO_OFF, async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      await this.autoTrade.setEnabled(false);
      await ctx.reply('⏹ Остановлено', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.command('autotrade', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();
      if (!arg || arg === 'status') {
        const st = await this.autoTrade.getState();
        const hasKeys = Boolean(
          this.config.get<string>('binance.apiKey')?.trim(),
        );
        await ctx.reply(
          `Авто: ${st.autoTradeEnabled ? 'ВКЛ' : 'ВЫКЛ'} · ${hasKeys ? 'ключи ✓' : 'без ключей'}`,
          { reply_markup: await this.mainKeyboardForUser(ctx) },
        );
        return;
      }
      if (arg === 'on') {
        const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
        await this.autoTrade.setEnabled(true, chatId);
        await ctx.reply('▶️ Работает', {
          reply_markup: await this.mainKeyboardForUser(ctx),
        });
        return;
      }
      if (arg === 'off') {
        await this.autoTrade.setEnabled(false);
        await ctx.reply('⏹ Остановлено', {
          reply_markup: await this.mainKeyboardForUser(ctx),
        });
        return;
      }
      await ctx.reply('/autotrade on | off | status');
    });

    void this.bot.api
      .setMyCommands([
        { command: 'start', description: 'Меню' },
        { command: 'stats', description: 'Статистика' },
        { command: 'history', description: 'История' },
        { command: 'market', description: 'Свечи 24h/7d/30d' },
        { command: 'autotrade', description: 'Автоторговля' },
      ])
      .catch(() => void 0);

    const connWarn = setTimeout(() => {
      this.logger.warn('Telegram: 25с без ответа от API');
    }, 25_000);

    void this.bot
      .start({
        onStart: (info) => {
          clearTimeout(connWarn);
          this.logger.log(`Telegram: polling OK @${info.username}`);
        },
      })
      .catch((err) => {
        clearTimeout(connWarn);
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Telegram polling не запустился: ${msg}`);
      });
  }

  private async mainKeyboardForUser(ctx: Context): Promise<Keyboard> {
    if (!this.isTelegramAdmin(ctx)) {
      return new Keyboard()
        .text(BTN_STATS)
        .text(BTN_HISTORY)
        .resized()
        .persistent();
    }
    const st = await this.prisma.botState.findUnique({
      where: { id: 'default' },
    });
    const on = st?.autoTradeEnabled ?? false;
    return new Keyboard()
      .text(BTN_STATS)
      .text(BTN_HISTORY)
      .row()
      .text(BTN_EXPORT)
      .row()
      .text(on ? BTN_AUTO_OFF : BTN_AUTO_ON)
      .resized()
      .persistent();
  }

  async onModuleDestroy() {
    await this.bot?.stop();
    this.bot = undefined;
  }

  private async claimUpdateOnce(updateId: number): Promise<boolean> {
    const client = this.redis.getClient();
    if (client) {
      try {
        const key = `telegram:update_claim:${updateId}`;
        const ok = await client.set(key, '1', 'EX', 600, 'NX');
        return ok === 'OK';
      } catch {
        /* fall through to local cache */
      }
    }
    if (this.claimedUpdateIdsLocal.has(updateId)) return false;
    this.claimedUpdateIdsLocal.add(updateId);
    setTimeout(() => this.claimedUpdateIdsLocal.delete(updateId), 600_000);
    return true;
  }

  async sendAlert(text: string) {
    const chatId = this.config.get<string>('telegramAlertChatId');
    if (!this.bot || !chatId) return;
    await this.bot.api.sendMessage(chatId, clip(text));
  }

  private async upsertUser(ctx: Context) {
    const id = ctx.from?.id;
    if (id == null) return;
    await this.prisma.telegramUser.upsert({
      where: { telegramId: String(id) },
      create: { telegramId: String(id) },
      update: {},
    });
  }

  private isTelegramAdmin(ctx: Context): boolean {
    const uid = ctx.from?.id;
    const admins = this.config.get<string[]>('adminTelegramIds') ?? [];
    return uid != null && admins.length > 0 && admins.includes(String(uid));
  }
}

function clip(s: string): string {
  return s.length > MAX_MSG ? s.slice(0, MAX_MSG) + '…' : s;
}
