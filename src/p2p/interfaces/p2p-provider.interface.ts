export interface P2pQuote {
  advNo: string;
  /** RUB per 1 USDT (or fiat per asset unit) */
  price: number;
  minAmount: number;
  maxAmount: number;
}

export interface P2pMarketSnapshot {
  asset: string;
  fiat: string;
  /** Лучшая цена, по которой можно купить USDT за фиат (стакан «BUY» на Binance). */
  bestBuyUsdtPrice: number | null;
  /** Лучшая цена, по которой можно продать USDT за фиат. */
  bestSellUsdtPrice: number | null;
  buyTop: P2pQuote[];
  sellTop: P2pQuote[];
  /** Подсказка, если стакан пустой или запрос не удался (для Telegram). */
  hint?: string;
}

export interface P2PProvider {
  readonly name: string;
  getMarketSnapshot(asset: string, fiat: string): Promise<P2pMarketSnapshot>;
}
