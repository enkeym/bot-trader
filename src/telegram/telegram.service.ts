import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context } from 'grammy';
import { AutoTradeService } from '../autotrade/auto-trade.service';
import { PrismaService } from '../prisma/prisma.service';
import { SimulationService } from '../order/simulation.service';
import { SpreadService } from '../strategy/spread.service';
import { TonService } from '../ton/ton.service';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;

  constructor(
    private readonly config: ConfigService,
    private readonly spread: SpreadService,
    private readonly simulation: SimulationService,
    private readonly prisma: PrismaService,
    private readonly ton: TonService,
    private readonly autoTrade: AutoTradeService,
  ) {}

  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') {
      this.logger.warn('Telegram disabled in NODE_ENV=test');
      return;
    }
    const token = this.config.get<string>('telegramBotToken');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN missing — Telegram disabled');
      return;
    }
    this.bot = new Bot(token);

    this.bot.command('start', async (ctx) => {
      await this.upsertUser(ctx);
      await ctx.reply(
        [
          'Trader P2P (MVP)',
          '/spread — спред USDT/RUB (Binance P2P)',
          '/simulate — симуляция (DRY_RUN), оценка прибыли в USDT',
          '/paper — накопленная бумажная статистика',
          '/stats — бумажный кошелёк, PnL, последние сделки',
          '/status — режим',
          '/connect — TON Connect манифест',
          '/autotrade on|off|status — авто-симуляция по таймеру (только админы)',
        ].join('\n'),
      );
    });

    this.bot.command('autotrade', async (ctx) => {
      const admins = this.config.get<string[]>('adminTelegramIds') ?? [];
      if (admins.length === 0) {
        await ctx.reply(
          'Задайте ADMIN_TELEGRAM_IDS в .env (ваш числовой user id через запятую).',
        );
        return;
      }
      const uid = ctx.from?.id;
      if (uid == null || !admins.includes(String(uid))) {
        await ctx.reply(
          'Команда только для администраторов (ADMIN_TELEGRAM_IDS).',
        );
        return;
      }
      const arg = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();
      const ms = this.config.get<number>('autoTrade.intervalMs') ?? 180_000;
      const dry = this.config.get<boolean>('dryRun');

      if (!arg || arg === 'status') {
        const st = await this.autoTrade.getState();
        const notify =
          this.config.get<string>('telegramAlertChatId') ??
          st.notifyChatId ??
          '—';
        await ctx.reply(
          [
            `Авто-симуляция: ${st.autoTradeEnabled ? 'ВКЛ' : 'ВЫКЛ'}`,
            `Интервал: ${ms} ms`,
            `Уведомления → chat: ${notify}`,
            `DRY_RUN=${dry} — на Binance ордера не отправляются, только запись SIMULATED в БД.`,
            '',
            'Реальная покупка по API в этом проекте не реализована.',
          ].join('\n'),
        );
        return;
      }
      if (arg === 'on') {
        const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
        await this.autoTrade.setEnabled(true, chatId);
        await ctx.reply(
          [
            'Авто-симуляция включена: по таймеру вызывается та же логика, что /simulate.',
            'Уведомление при новой записи: TELEGRAM_ALERT_CHAT_ID или этот чат.',
          ].join('\n'),
        );
        return;
      }
      if (arg === 'off') {
        await this.autoTrade.setEnabled(false);
        await ctx.reply('Авто-симуляция выключена.');
        return;
      }
      await ctx.reply('Использование: /autotrade on | off | status');
    });

    this.bot.command('spread', async (ctx) => {
      if (!(await this.requireAccess(ctx))) return;
      const asset = this.config.get<string>('market.asset') ?? 'USDT';
      const fiat = this.config.get<string>('market.fiat') ?? 'RUB';
      const ev = await this.spread.evaluate(asset, fiat);
      const lines = [
        `Пара: ${asset}/${fiat}`,
        `Лучшая покупка USDT (${fiat} за 1 USDT): ${ev.snapshot.bestBuyUsdtPrice ?? '—'}`,
        `Лучшая продажа USDT (${fiat} за 1 USDT): ${ev.snapshot.bestSellUsdtPrice ?? '—'}`,
        `Грубый спред: ${ev.grossSpreadPercent?.toFixed(3) ?? '—'}%`,
        `Чистый спред: ${ev.netSpreadPercent?.toFixed(3) ?? '—'}%`,
      ];
      if (ev.snapshot.hint) {
        lines.push('', ev.snapshot.hint);
      }
      await ctx.reply(lines.join('\n'));
    });

    this.bot.command('simulate', async (ctx) => {
      if (!(await this.requireAccess(ctx))) return;
      const maxNotional =
        this.config.get<number>('strategy.maxNotionalUsdt') ?? 500;
      const res = await this.simulation.runPairSimulation(maxNotional);
      const profitLine =
        res.estimatedProfitUsdt != null
          ? `Оценка прибыли за цикл (бумага, USDT): ~${res.estimatedProfitUsdt} (notional × чистый спред %)`
          : 'Оценка прибыли: — (спред ≤ 0 или нет данных)';
      const lines = [
        `Риск OK: ${res.ok}`,
        profitLine,
        `DRY_RUN: ${res.dryRun}`,
        `EXECUTION_MODE: ${res.executionMode}`,
        res.order
          ? `OrderIntent: ${res.order.id} (${res.order.status})`
          : 'OrderIntent: —',
        '',
        'Это не реальная прибыль: нет сделки на бирже и нет учёта комиссий/проскальзывания.',
      ];
      if (res.ev.snapshot.hint) {
        lines.splice(1, 0, res.ev.snapshot.hint, '');
      }
      await ctx.reply(lines.join('\n'));
    });

    this.bot.command('paper', async (ctx) => {
      if (!(await this.requireAccess(ctx))) return;
      const s = await this.simulation.getPaperStats();
      await ctx.reply(
        [
          'Бумажная статистика (SIMULATED в БД):',
          `Записей симуляций: ${s.simulatedTrades}`,
          `С оценкой прибыли: ${s.tradesWithEstimate}`,
          `Сумма оценок прибыли (USDT): ~${s.totalEstimatedProfitUsdt}`,
          '',
          'Реальный TON не нужен; подключение кошелька не влияет на эти цифры.',
        ].join('\n'),
      );
    });

    this.bot.command('stats', async (ctx) => {
      if (!(await this.requireAccess(ctx))) return;
      const d = await this.simulation.getPaperDashboard();
      const st = await this.autoTrade.getState();
      const dry = this.config.get<boolean>('dryRun');
      const fiat = this.config.get<string>('market.fiat') ?? 'RUB';
      const asset = this.config.get<string>('market.asset') ?? 'USDT';
      await ctx.reply(
        [
          '— Бумажный отчёт (не баланс Binance / не TON) —',
          `Пара: ${asset}/${fiat} | DRY_RUN=${dry}`,
          `Авто-симуляция: ${st.autoTradeEnabled ? 'ВКЛ' : 'ВЫКЛ'}`,
          '',
          `Бумажный кошелёк: ${d.currentPaperWalletUsdt} USDT (старт ${d.startingPaperWalletUsdt}, см. PAPER_WALLET_START_USDT)`,
          `Сделок SIMULATED: ${d.totalSimulatedTrades} (оценка прибыли >0: ${d.tradesWithPositiveEstimate})`,
          `Суммарная оценка PnL: ${d.totalEstimatedPnLUsdt} USDT`,
          '',
          'Последние записи (время UTC):',
          d.recentTradeLines.length > 0 ? d.recentTradeLines.join('\n') : '—',
          '',
          'Направление «в плюс» здесь = рос суммарный спред в симуляциях; это не гарантия реальной торговли.',
        ].join('\n'),
      );
    });

    this.bot.command('status', async (ctx) => {
      const dry = this.config.get<boolean>('dryRun');
      const mode = this.config.get<string>('executionMode');
      const min = this.config.get<number>('strategy.minSpreadPercent');
      const st = await this.autoTrade.getState();
      await ctx.reply(
        [
          `DRY_RUN=${dry}`,
          `EXECUTION_MODE=${mode}`,
          `MIN_SPREAD_PERCENT=${min}`,
          `Авто-симуляция: ${st.autoTradeEnabled ? 'on' : 'off'}`,
        ].join('\n'),
      );
    });

    this.bot.command('connect', async (ctx) => {
      const base = this.config.get<string>('publicBaseUrl') ?? '';
      await ctx.reply(
        [
          'TON Connect manifest (разместите приложение по HTTPS и укажите URL в TON_CONNECT_MANIFEST_URL):',
          `${base}/tonconnect-manifest.json`,
        ].join('\n'),
      );
    });

    await this.bot.start();
    this.logger.log('Telegram long polling started');
  }

  async onModuleDestroy() {
    await this.bot?.stop();
  }

  /** Опциональные алерты из cron (если задан TELEGRAM_ALERT_CHAT_ID). */
  async sendAlert(text: string) {
    const chatId = this.config.get<string>('telegramAlertChatId');
    if (!this.bot || !chatId) return;
    await this.bot.api.sendMessage(chatId, text, {
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
    await ctx.reply('Нужен доступ (TON). См. /connect');
    return false;
  }
}
