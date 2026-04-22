/**
 * Компактные хелперы форматирования для Telegram-отчётов.
 * Таблицы вырезаны в пользу коротких 1–3 строчных шаблонов.
 */

export function fmtStatsNumber(n: number, minFd = 2, maxFd = 4): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: minFd,
    maximumFractionDigits: maxFd,
  });
}

export function fmtStatsQtyBase(n: number): string {
  if (!Number.isFinite(n)) return '—';
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

export function fmtDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}ч ${m}м`;
  return `${Math.max(1, totalMin)}м`;
}

export type ExitKind =
  | 'take_profit'
  | 'stop_loss'
  | 'emergency_drawdown'
  | 'trailing_stop';

export function exitKindShort(k: string | null | undefined): string {
  switch (k) {
    case 'take_profit':
      return '🎯';
    case 'stop_loss':
      return '🛑';
    case 'emergency_drawdown':
      return '⚠️';
    case 'trailing_stop':
      return '📉';
    default:
      return '💸';
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

function fmtSignedMoney(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${fmtStatsNumber(v, 2, 2)}$`;
}

function fmtSignedPct(v: number): string {
  if (!Number.isFinite(v)) return '';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${fmtStatsNumber(v, 2, 2)}%`;
}

/** Одна строка на сделку вида: «DD.MM HH:mm · 🟢 Купил 0.226 @ 88.37 (−19.97$)». */
export function formatHistoryRow(row: TelegramStatsHistoryRow): string {
  if (row.kind === 'other') return row.line;
  const t = fmtStatsDateTime(row.at);
  if (row.kind === 'spot_buy') {
    return `${t} · 🟢 Купил ${fmtStatsQtyBase(row.baseQty)} ${row.baseAsset} @ ${fmtStatsNumber(row.avgPrice, 2, 2)} (−${fmtStatsNumber(row.quoteQty, 2, 2)}$)`;
  }
  const icon = exitKindShort(row.exitKind);
  const rp = row.realizedPnlUsdt;
  let pnlStr = '';
  if (rp != null && Number.isFinite(rp)) {
    const proceeds = row.quoteQty;
    const cost = proceeds - rp;
    const pct = cost > 0 ? (rp / cost) * 100 : NaN;
    pnlStr = ` ${fmtSignedMoney(rp)}`;
    if (Number.isFinite(pct)) pnlStr += ` / ${fmtSignedPct(pct)}`;
  }
  const hold =
    row.holdMs != null && Number.isFinite(row.holdMs) && row.holdMs > 0
      ? ` · ${fmtDurationShort(row.holdMs)}`
      : '';
  return `${t} · ${icon} Продал ${fmtStatsQtyBase(row.baseQty)} ${row.baseAsset} @ ${fmtStatsNumber(row.avgPrice, 2, 2)}${pnlStr}${hold}`;
}

/** Каждая сделка — одна строка. */
export function buildTelegramStatsHistoryBlocks(
  rows: TelegramStatsHistoryRow[],
): string[] {
  return rows.map(formatHistoryRow);
}
