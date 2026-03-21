/**
 * UTC-расписание для автоторговли: окно часов и дни недели (ISO: Пн=1 … Вс=7).
 */

export type TradingWindowUtc = {
  /** Минуты от полуночи UTC [0, 1440) */
  startMin: number;
  endMin: number;
};

function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Формат `08:00-21:00` или пусто = без ограничения по часам. */
export function parseTradingWindowUtc(
  raw: string | undefined,
): TradingWindowUtc | null {
  if (raw == null || raw.trim() === '') return null;
  const parts = raw.trim().split('-');
  if (parts.length !== 2) return null;
  const a = parseHm(parts[0]);
  const b = parseHm(parts[1]);
  if (a == null || b == null) return null;
  return { startMin: a, endMin: b };
}

/**
 * Дни недели UTC: `1-5` (Пн–Пт), `1,3,5`, пусто = все дни.
 */
export function parseTradingDaysUtc(
  raw: string | undefined,
): Set<number> | null {
  if (raw == null || raw.trim() === '') return null;
  const out = new Set<number>();
  for (const segment of raw.split(',')) {
    const s = segment.trim();
    if (!s) continue;
    if (s.includes('-')) {
      const [fromS, toS] = s.split('-').map((x) => x.trim());
      const from = parseInt(fromS, 10);
      const to = parseInt(toS, 10);
      if (
        Number.isNaN(from) ||
        Number.isNaN(to) ||
        from < 1 ||
        from > 7 ||
        to < 1 ||
        to > 7
      ) {
        return null;
      }
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let d = lo; d <= hi; d++) out.add(d);
    } else {
      const d = parseInt(s, 10);
      if (Number.isNaN(d) || d < 1 || d > 7) return null;
      out.add(d);
    }
  }
  return out.size > 0 ? out : null;
}

/** ISO weekday: Monday = 1 … Sunday = 7 */
export function utcIsoWeekday(d: Date): number {
  const js = d.getUTCDay(); // 0 Sun … 6 Sat
  return js === 0 ? 7 : js;
}

export function isMinuteInWindow(
  minuteOfDay: number,
  w: TradingWindowUtc,
): boolean {
  const { startMin, endMin } = w;
  if (startMin === endMin) return true;
  if (startMin < endMin) {
    // Интервал в один календарный день UTC, конец включительно (21:00 — ещё внутри).
    return minuteOfDay >= startMin && minuteOfDay <= endMin;
  }
  // Окно через полночь
  return minuteOfDay >= startMin || minuteOfDay <= endMin;
}

export function isWithinTradingScheduleUtc(
  now: Date,
  window: TradingWindowUtc | null,
  days: Set<number> | null,
): boolean {
  if (days != null && !days.has(utcIsoWeekday(now))) return false;
  if (window == null) return true;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return isMinuteInWindow(minuteOfDay, window);
}
