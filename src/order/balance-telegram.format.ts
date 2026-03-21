/**
 * Человекочитаемый вывод Spot-баланса в Telegram (без жаргона free/lock).
 */
export function formatSpotBalanceTelegramLines(
  baseAsset: string,
  usdt: { free: string; locked: string } | undefined,
  baseRow: { free: string; locked: string } | undefined,
): string[] {
  const fmtQuote = (n: number) =>
    n.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });

  const fmtBase = (n: number) => {
    const s = n.toFixed(8).replace(/\.?0+$/, '');
    return s === '' ? '0' : s;
  };

  const out: string[] = [];

  const uf = usdt ? parseFloat(usdt.free) : 0;
  const ul = usdt ? parseFloat(usdt.locked) : 0;
  const uTot = uf + ul;

  out.push(`USDT — котируемая валюта (оплата покупок в этой паре)`);
  out.push(`  всего: ${fmtQuote(uTot)} USDT`);
  out.push(`  свободно (доступно сейчас): ${fmtQuote(uf)}`);
  out.push(
    ul > 0
      ? `  в ордерах (заморожено): ${fmtQuote(ul)}`
      : `  в ордерах: 0 — ничего не заморожено`,
  );

  out.push('');
  out.push(`${baseAsset} — базовый актив пары (купленный объём)`);
  if (baseRow) {
    const bf = parseFloat(baseRow.free);
    const bl = parseFloat(baseRow.locked);
    const bt = bf + bl;
    out.push(`  всего: ${fmtBase(bt)} ${baseAsset}`);
    out.push(`  свободно: ${fmtBase(bf)}`);
    out.push(
      bl > 0
        ? `  в ордерах: ${fmtBase(bl)}`
        : `  в ордерах: 0 — ничего не заморожено`,
    );
  } else {
    out.push(`  на счёте нет или 0 ${baseAsset}`);
  }

  return out;
}
