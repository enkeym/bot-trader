/**
 * Оформление сводки /stats для Telegram: рамки ┌─│└, выравнивание, даты.
 */

export const TELEGRAM_STATS_LINE_WIDTH = 36;

export function telegramStatsBoxTop(title: string): string {
  const s = `┌─ ${title} `;
  return s + '─'.repeat(Math.max(1, TELEGRAM_STATS_LINE_WIDTH - s.length));
}

export function telegramStatsBoxBottom(): string {
  return `└${'─'.repeat(TELEGRAM_STATS_LINE_WIDTH - 1)}`;
}

/** Пустая строка внутри рамки */
export function telegramStatsBoxBlank(): string {
  return '│';
}

/** Текст с отступом (два пробела после │) */
export function telegramStatsLine(text: string): string {
  return `│  ${text}`;
}

/** Горизонталь внутри блока (как в примере ━━━) */
export function telegramStatsInnerHr(): string {
  return `│  ${'━'.repeat(Math.max(8, TELEGRAM_STATS_LINE_WIDTH - 4))}`;
}

export function telegramStatsHistorySeparator(): string {
  return `│  ${'─ '.repeat(14).trimEnd()}`;
}

export function fmtStatsNumber(n: number, minFd = 2, maxFd = 4): string {
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: minFd,
    maximumFractionDigits: maxFd,
  });
}

export function fmtStatsQtyBase(n: number): string {
  const s = n.toFixed(8).replace(/\.?0+$/, '');
  return s === '' ? '0' : s;
}

/** DD.MM HH:mm (Europe/Moscow по умолчанию) */
export function fmtStatsDateTime(d: Date, timeZone = 'Europe/Moscow'): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).formatToParts(d);
  const v = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? '';
  return `${v('day')}.${v('month')} ${v('hour')}:${v('minute')}`;
}

export function fmtVolumeShort(vol: number, baseSuffix: string): string {
  if (!Number.isFinite(vol) || vol < 0) return `— ${baseSuffix}`;
  if (vol >= 1_000_000) {
    return `${(vol / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M ${baseSuffix}`;
  }
  if (vol >= 1_000) {
    return `${(vol / 1_000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}K ${baseSuffix}`;
  }
  return `${fmtStatsNumber(vol, 2, 4)} ${baseSuffix}`;
}

export function fmtUptimeProcess(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}д`);
  parts.push(`${h}ч`);
  parts.push(`${m}м`);
  return parts.join(' ');
}

export function fmtAutotradeIntervalRu(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `~${s}с`;
  const m = Math.round(s / 60);
  return `~${m}мин`;
}

export function pctArrow(changePct: number): string {
  if (!Number.isFinite(changePct)) return '';
  if (changePct > 0) return '↑';
  if (changePct < 0) return '↓';
  return '→';
}

export function fmtDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) {
    return `~${h}ч ${m.toString().padStart(2, '0')}м`;
  }
  return `~${Math.max(1, totalMin)}м`;
}

function exitKindRu(k: string | null | undefined): string {
  switch (k) {
    case 'take_profit':
      return '🎯 тейк-профит';
    case 'stop_loss':
      return '🛡 стоп';
    case 'emergency_drawdown':
      return '⚡ авария';
    default:
      return '';
  }
}

export type TelegramStatsHistoryRow =
  | {
      kind: 'spot_buy';
      at: Date;
      baseQty: number;
      quoteQty: number;
      avgPrice: number;
      baseAsset: string;
      quoteAsset: string;
    }
  | {
      kind: 'spot_sell';
      at: Date;
      baseQty: number;
      quoteQty: number;
      avgPrice: number;
      baseAsset: string;
      quoteAsset: string;
      exitKind: string | null | undefined;
      realizedPnlUsdt: number | null | undefined;
      holdMs: number | null | undefined;
    }
  | { kind: 'other'; line: string };

function formatOneHistoryRow(row: TelegramStatsHistoryRow): string[] {
  if (row.kind === 'other') {
    return [telegramStatsLine(row.line)];
  }
  const t = fmtStatsDateTime(row.at);
  const lines: string[] = [
    telegramStatsLine(`🕐 ${t}`),
    telegramStatsBoxBlank(),
  ];
  if (row.kind === 'spot_buy') {
    lines.push(telegramStatsLine('📥 ПОКУПКА'));
    lines.push(
      telegramStatsLine(
        `├ Кол-во:  ${fmtStatsQtyBase(row.baseQty)} ${row.baseAsset}`,
      ),
    );
    lines.push(
      telegramStatsLine(
        `├ Цена:    ${fmtStatsNumber(row.avgPrice, 2, 2)} ${row.quoteAsset}`,
      ),
    );
    lines.push(
      telegramStatsLine(
        `├ Сумма:   −${fmtStatsNumber(row.quoteQty)} ${row.quoteAsset}`,
      ),
    );
    lines.push(telegramStatsLine('└ Причина: сигнал бота'));
    return lines;
  }
  const tag = exitKindRu(row.exitKind);
  const head = tag ? `📤 ПРОДАЖА ${tag}` : '📤 ПРОДАЖА';
  lines.push(telegramStatsLine(head));

  const tailParts: string[] = [
    `Кол-во:  ${fmtStatsQtyBase(row.baseQty)} ${row.baseAsset}`,
    `Цена:    ${fmtStatsNumber(row.avgPrice, 2, 2)} ${row.quoteAsset}`,
    `Сумма:   +${fmtStatsNumber(row.quoteQty)} ${row.quoteAsset}`,
  ];
  const rtp = row.realizedPnlUsdt;
  if (rtp != null && Number.isFinite(rtp)) {
    const proceeds = row.quoteQty;
    const costBasis = proceeds - rtp;
    const pct = costBasis > 0 ? (rtp / costBasis) * 100 : Number.NaN;
    const pctStr = Number.isFinite(pct)
      ? ` (${rtp >= 0 ? '+' : ''}${fmtStatsNumber(pct, 2, 2)}%)`
      : '';
    tailParts.push(
      `Прибыль: ${rtp >= 0 ? '+' : ''}${fmtStatsNumber(rtp)} ${row.quoteAsset}${pctStr}`,
    );
  }
  if (row.holdMs != null && Number.isFinite(row.holdMs) && row.holdMs > 0) {
    tailParts.push(`Время в позиции: ${fmtDurationShort(row.holdMs)}`);
  }
  for (let i = 0; i < tailParts.length; i++) {
    const branch = i === tailParts.length - 1 ? '└' : '├';
    lines.push(telegramStatsLine(`${branch} ${tailParts[i]}`));
  }
  return lines;
}

/** Линии тела блока «история» (без внешней рамки). */
export function buildTelegramStatsHistoryBlocks(
  rows: TelegramStatsHistoryRow[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      out.push(telegramStatsBoxBlank());
      out.push(telegramStatsHistorySeparator());
      out.push(telegramStatsBoxBlank());
    }
    out.push(...formatOneHistoryRow(rows[i]));
  }
  return out;
}
