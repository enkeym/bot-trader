import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context, Keyboard } from 'grammy';
import { AutoTradeService } from '../autotrade/auto-trade.service';
import { PrismaService } from '../prisma/prisma.service';
import { SimulationService } from '../order/simulation.service';
import { TonService } from '../ton/ton.service';

const MAX_MSG = 4000;

const BTN_STATS = '📊 Статистика';
const BTN_AUTO_ON = '▶️ Включить автоторговлю';
const BTN_AUTO_OFF = '⏹ Выключить автоторговлю';

@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;

  /** Защита от двойной отправки статистики на один update (дубли handlers / два polling). */
  private readonly statsUpdateIdsHandled = new Set<number>();

  constructor(
    private readonly config: ConfigService,
    private readonly simulation: SimulationService,
    private readonly prisma: PrismaService,
    private readonly ton: TonService,
    private readonly autoTrade: AutoTradeService,
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

    if (this.bot) {
      this.logger.warn(
        'Telegram: повторный onApplicationBootstrap — бот уже создан, пропуск (иначе дублируются ответы)',
      );
      return;
    }

    this.bot = new Bot(token);

    this.bot.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Telegram: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
    });

    const statsHandler = async (ctx: Context) => {
      const uid = ctx.update.update_id;
      if (this.statsUpdateIdsHandled.has(uid)) {
        this.logger.debug(`stats: update ${uid} уже обработан, пропуск`);
        return;
      }
      this.statsUpdateIdsHandled.add(uid);
      setTimeout(() => this.statsUpdateIdsHandled.delete(uid), 120_000);

      if (!(await this.requireAccess(ctx))) return;
      const text = await this.simulation.buildTelegramTradingReport();
      await ctx.reply(
        text.length > MAX_MSG ? text.slice(0, MAX_MSG) + '…' : text,
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    };

    this.bot.command('start', async (ctx) => {
      await this.upsertUser(ctx);
      await ctx.reply(
        [
          'Трейдер Binance Spot + сигнал по P2P-спреду.',
          '',
          'Кнопки ниже — статистика и (для админа) автоторговля.',
          'Команды: /stats, /autotrade',
        ].join('\n'),
        { reply_markup: await this.mainKeyboardForUser(ctx) },
      );
    });

    this.bot.command('menu', async (ctx) => {
      await ctx.reply('Меню:', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    /** Одна регистрация на обе команды — меньше риска двойного срабатывания. */
    this.bot.command(['stats', 'статистика'], statsHandler);

    this.bot.hears(BTN_STATS, statsHandler);

    this.bot.hears(BTN_AUTO_ON, async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
      await this.autoTrade.setEnabled(true, chatId);
      await ctx.reply('Автоторговля включена.', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.hears(BTN_AUTO_OFF, async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      await this.autoTrade.setEnabled(false);
      await ctx.reply('Автоторговля выключена.', {
        reply_markup: await this.mainKeyboardForUser(ctx),
      });
    });

    this.bot.command('autotrade', async (ctx) => {
      if (!(await this.requireAdmin(ctx))) return;
      const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();

      if (!arg || arg === 'status') {
        const st = await this.autoTrade.getState();
        const dry = this.config.get<boolean>('dryRun');
        const key = this.config.get<string>('binance.apiKey');
        const hasKeys = Boolean(key?.trim());
        const mode = dry
          ? 'бумага (Spot не вызывается)'
          : hasKeys
            ? 'Spot Binance'
            : 'нет API-ключей';
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

  /** Клавиатура: статистика; для админа — одна кнопка вкл/выкл авто. */
  private async mainKeyboardForUser(ctx: Context): Promise<Keyboard> {
    const uid = ctx.from?.id;
    const admins = this.config.get<string[]>('adminTelegramIds') ?? [];
    const isAdmin =
      uid != null && admins.length > 0 && admins.includes(String(uid));

    if (!isAdmin) {
      return new Keyboard().text(BTN_STATS).resized().persistent();
    }

    const st = await this.prisma.botState.findUnique({
      where: { id: 'default' },
    });
    const on = st?.autoTradeEnabled ?? false;
    return new Keyboard()
      .text(BTN_STATS)
      .row()
      .text(on ? BTN_AUTO_OFF : BTN_AUTO_ON)
      .resized()
      .persistent();
  }

  async onModuleDestroy() {
    await this.bot?.stop();
    this.bot = undefined;
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

  private async requireAdmin(ctx: Context): Promise<boolean> {
    const admins = this.config.get<string[]>('adminTelegramIds') ?? [];
    if (admins.length === 0) {
      await ctx.reply('Задайте ADMIN_TELEGRAM_IDS в .env.');
      return false;
    }
    const id = ctx.from?.id;
    if (id == null || !admins.includes(String(id))) {
      await ctx.reply('Нужны права администратора.');
      return false;
    }
    return true;
  }

  private async requireAccess(ctx: Context): Promise<boolean> {
    if (!this.ton.isAccessRequired()) return true;
    const id = ctx.from?.id;
    if (id == null) return false;
    const admins = this.config.get<string[]>('adminTelegramIds') ?? [];
    if (admins.includes(String(id))) return true;
    const u = await this.prisma.telegramUser.findUnique({
      where: { telegramId: String(id) },
    });
    if (u?.accessPaid) return true;
    await ctx.reply(
      'Нужен доступ. Обратитесь к администратору или настройте TON в проекте.',
    );
    return false;
  }
}
