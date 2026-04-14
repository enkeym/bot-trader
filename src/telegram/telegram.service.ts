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
const BTN_SIGNAL = '📡 Сигнал рынка';
const BTN_EXPORT = '📦 Выгрузка JSON';

@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;

  /** Если Redis нет — только в рамках одного процесса (два инстанса без Redis всё ещё дублируют). */
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
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN пуст — Telegram выключен (проверьте .env / env в Docker)',
      );
      return;
    }

    const adminIds = this.config.get<string[]>('adminTelegramIds') ?? [];
    if (adminIds.length === 0) {
      this.logger.warn(
        'ADMIN_TELEGRAM_IDS пуст — команды бота не обрабатываются (ни для кого)',
      );
    }

    if (this.bot) {
      this.logger.warn(
        'Telegram: повторный onApplicationBootstrap — бот уже создан, пропуск (иначе дублируются ответы)',
      );
      return;
    }

    this.bot = new Bot(token);

    /**
     * Самый первый middleware: один update_id = один проход по цепочке.
     * Два процесса с одним токеном (PM2 cluster, два контейнера) иначе оба отвечают —
     * при REDIS_URL дедуп через SET NX общий для всех инстансов.
     */
    this.bot.use(async (ctx, next) => {
      const id = ctx.update.update_id;
      const claimed = await this.claimUpdateOnce(id);
      if (!claimed) {
        this.logger.warn(
          `Telegram: update_id=${id} уже обработан — пропуск (второй инстанс бота или повтор; задайте REDIS_URL для общего кэша)`,
        );
        return;
      }
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
      await ctx.reply(
        text.length > MAX_MSG ? text.slice(0, MAX_MSG) + '…' : text,
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    };
    const historyHandler = async (ctx: Context) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const text = await this.simulation.buildTelegramTradingHistoryReport();
      await ctx.reply(
        text.length > MAX_MSG ? text.slice(0, MAX_MSG) + '…' : text,
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    };

    this.bot.command('start', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      await this.upsertUser(ctx);
      await ctx.reply(
        [
          'Трейдер Binance Spot + сигнал по P2P-спреду.',
          '',
          'Кнопки ниже — статистика, сигнал рынка и автоторговля.',
          'Команды: /stats, /market, /autotrade',
        ].join('\n'),
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    });

    this.bot.command('menu', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      await ctx.reply('Меню:', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    /**
     * Статистика: одна ветка middleware (/stats, /статистика, кнопка клавиатуры).
     * Раньше были отдельно `command` и `hears` — в стеке grammy это давало два вызова на один апдейт.
     */
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

    const signalHandler = async (ctx: Context) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const signal = await this.simulation.computeMarketEntrySignal();
      const verdictRu =
        signal.verdict === 'DA'
          ? '✅ ДА'
          : signal.verdict === 'OSTOROZHNO'
            ? '⚠️ ОСТОРОЖНО'
            : '🚫 НЕТ';
      const text = [
        '--- СИГНАЛ РЫНКА ---',
        `Входить в рынок: ${verdictRu}`,
        `Score: ${signal.score}/100`,
        `Тренд 24h: ${signal.trend24h.changePct >= 0 ? '+' : ''}${signal.trend24h.changePct.toFixed(1)}% (${signal.trend24h.label})`,
        `Тренд 7d: ${signal.trend7d.changePct >= 0 ? '+' : ''}${signal.trend7d.changePct.toFixed(1)}% (${signal.trend7d.label})`,
        `Волатильность: ${signal.volatility.stdev.toFixed(2)} (${signal.volatility.label})`,
        `Win rate 20: ${signal.winRate.rate.toFixed(0)}% (${signal.winRate.wins}/${signal.winRate.total})`,
      ].join('\n');
      await ctx.reply(text, {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    };

    this.bot
      .filter((ctx) => ctx.hasText(BTN_SIGNAL))
      .use(signalHandler);

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

    this.bot
      .filter((ctx) => ctx.hasText(BTN_EXPORT))
      .use(exportHandler);

    this.bot.command('market', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const arg = ctx.message?.text?.trim().split(/\s+/)[1];
      const report = await this.marketStats.getReport(arg);
      if (!report) {
        await ctx.reply(
          'Не удалось загрузить свечи Binance (проверьте сеть и BINANCE_SPOT_BASE_URL).',
          { reply_markup: await this.mainKeyboardForUser(ctx) },
        );
        return;
      }
      const text = this.marketStats.formatTelegram(report);
      await ctx.reply(
        text.length > MAX_MSG ? text.slice(0, MAX_MSG) + '…' : text,
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    });

    this.bot.hears(BTN_AUTO_ON, async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
      await this.autoTrade.setEnabled(true, chatId);
      await ctx.reply('Автоторговля включена.', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.hears(BTN_AUTO_OFF, async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      await this.autoTrade.setEnabled(false);
      await ctx.reply('Автоторговля выключена.', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.command('autotrade', async (ctx) => {
      if (!this.isTelegramAdmin(ctx)) return;
      const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();

      if (!arg || arg === 'status') {
        const st = await this.autoTrade.getState();
        const key = this.config.get<string>('binance.apiKey');
        const hasKeys = Boolean(key?.trim());
        const mode = hasKeys ? 'Spot Binance' : 'нет API-ключей';
        await ctx.reply(
          [
            `Автоторговля: ${st.autoTradeEnabled ? 'ВКЛ' : 'ВЫКЛ'}`,
            `Режим: ${mode}`,
          ].join('\n'),
          { reply_markup: await this.mainKeyboardForUser(ctx) },
        );
        return;
      }
      if (arg === 'on') {
        const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
        await this.autoTrade.setEnabled(true, chatId);
        await ctx.reply('Включено.', {
          reply_markup: await this.mainKeyboardForUser(ctx),
        });
        return;
      }
      if (arg === 'off') {
        await this.autoTrade.setEnabled(false);
        await ctx.reply('Выключено.', {
          reply_markup: await this.mainKeyboardForUser(ctx),
        });
        return;
      }
      await ctx.reply('Использование: /autotrade on | off | status');
    });

    // setMyCommands не должен блокировать start(): при недоступности api.telegram.org
    // (сеть, РФ без VPN) await setMyCommands зависал — polling никогда не запускался.
    void this.bot.api
      .setMyCommands([
        { command: 'start', description: 'Меню и кнопки' },
        { command: 'menu', description: 'Показать клавиатуру' },
        { command: 'stats', description: 'Статистика' },
        { command: 'history', description: 'История операций' },
        { command: 'market', description: 'Свечи: 24h/7d/30d по паре Spot' },
        { command: 'autotrade', description: 'Автоторговля (админ)' },
      ])
      .then(() =>
        this.logger.log(
          'Telegram: команды меню зарегистрированы (setMyCommands)',
        ),
      )
      .catch((e) =>
        this.logger.warn(
          `Telegram setMyCommands не выполнен (бот всё равно работает): ${e}`,
        ),
      );

    this.logger.log(
      'Telegram: bot.start() → HTTPS к api.telegram.org (deleteWebhook, потом long polling)',
    );

    const connWarn = setTimeout(() => {
      this.logger.warn(
        'Telegram: за 25 с нет ответа от API — из контейнера, вероятно, недоступен api.telegram.org. Варианты: VPN на хосте, HTTPS_PROXY для Docker, DNS 8.8.8.8, на WSL иногда мешает сеть Windows.',
      );
    }, 25_000);

    void this.bot
      .start({
        onStart: (info) => {
          clearTimeout(connWarn);
          this.logger.log(
            `Telegram: polling OK, бот @${info.username} (id ${info.id})`,
          );
        },
      })
      .catch((err) => {
        clearTimeout(connWarn);
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Telegram polling не запустился: ${msg}`);
      });

    this.logger.log(
      'Telegram: start() поставлен в очередь (не ждём setMyCommands)',
    );
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
      .text(BTN_SIGNAL)
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

  /** true = мы первые «захватили» апдейт, можно обрабатывать; false = дубликат. */
  private async claimUpdateOnce(updateId: number): Promise<boolean> {
    const client = this.redis.getClient();
    if (client) {
      try {
        const key = `telegram:update_claim:${updateId}`;
        const ok = await client.set(key, '1', 'EX', 600, 'NX');
        return ok === 'OK';
      } catch (e) {
        this.logger.warn(
          `Telegram: Redis claim failed (${e instanceof Error ? e.message : String(e)}), локальный кэш`,
        );
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
    const body = text.length > MAX_MSG ? text.slice(0, MAX_MSG) + '…' : text;
    await this.bot.api.sendMessage(chatId, body, {
      disable_notification: false,
    });
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

  /** Команды и клавиатура только для ID из ADMIN_TELEGRAM_IDS (без ответа чужим). */
  private isTelegramAdmin(ctx: Context): boolean {
    const uid = ctx.from?.id;
    const admins = this.config.get<string[]>('adminTelegramIds') ?? [];
    return uid != null && admins.length > 0 && admins.includes(String(uid));
  }
}
