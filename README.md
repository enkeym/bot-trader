# Trader — Spot-бот на Binance (ATR + Gemini)

Node.js + NestJS + TypeScript. Торгует **Spot SOL/USDT** по стратегии тренд-фолловинг с
ATR-нормализованными SL/TP, подтверждением 4h и опциональной AI-проверкой через Gemini 1.5 Flash.
Постгрес для учёта, опциональный Redis для антиспама Telegram.

> При заданных `BINANCE_API_KEY` / `BINANCE_API_SECRET` бот шлёт **реальные** MARKET-ордера.
> На [testnet.binance.vision](https://testnet.binance.vision) — безопасное окружение без реальных средств.
> В сообщениях testnet-сделки помечены тегом `⚠️ TESTNET`.

---

## Стратегия

1. **Регим-фильтр (1h + 4h)** — [src/strategy/regime.service.ts](src/strategy/regime.service.ts):
   - ADX(14) ≥ `ADX_MIN` (по умолчанию 20) — тренд существует.
   - Цена 1h > EMA50 и 4h > EMA50 — тренд согласован.
   - RSI(14) в коридоре `RSI_ENTRY_MIN..RSI_ENTRY_MAX` (40..65) — откат без перекупленности.
   - Цена выше 4h swing low — не ловим «падающий нож».
2. **ATR-стопы** — SL = `entry − ATR_SL_MULT × ATR14`, TP = `entry + ATR_TP_MULT × ATR14`.
   Эффективный TP не ниже `2 × SPOT_TAKER_FEE_PERCENT + MIN_NET_TP_PERCENT` — чтобы чистая
   прибыль после комиссий гарантированно оставалась положительной.
3. **Трейлинг** — после профита `ATR_TRAIL_ACTIVATION_MULT × ATR` трейл-стоп
   подтягивается за ценой на дистанцию начального SL.
4. **Сайзинг по риску** — `notional ≈ (equity × RISK_PER_TRADE_PERCENT%) / SL%`,
   ограничен `MAX_NOTIONAL_USDT` и `BINANCE_SPOT_MAX_QUOTE_USDT`.
5. **AI-подтверждение (опционально)** — если `GEMINI_ENABLED=true` и ключ задан,
   после зелёной техничке запрос к Gemini 1.5 Flash (бесплатный тариф, 15 RPM).
   При ответе `SKIP` или `confidence < GEMINI_MIN_CONFIDENCE` вход пропускается.
   Любая ошибка/таймаут/квота → **fail-open** (решает техничка).

### Защиты
- Дневной стоп `DAILY_MAX_LOSS_USDT`.
- Пауза на `LOSS_STREAK_COOLDOWN_MS` после `MAX_CONSECUTIVE_LOSS_SELLS` убытков подряд.
- Аварийный выход `BINANCE_SPOT_ROUNDTRIP_EMERGENCY_DRAWDOWN_PERCENT` от пика.
- Расписание `TRADING_WINDOW_UTC` / `TRADING_DAYS_UTC`.
- Circuit breaker по эквити vs `STATS_EQUITY_BASELINE_USDT`.
- Liquidity guard: не заходим крупнее 5% от среднего 1h объёма.
- `inFlight` guard: тик не перекрывается сам с собой.

---

## Запуск

```bash
cp .env.example .env   # заполните секреты
docker compose up -d postgres redis
npx prisma migrate deploy
npm install
npm run start:prod
```

Или всё в Docker:

```bash
docker compose up -d --build
```

---

## Основные переменные (.env)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BINANCE_SPOT_BASE_URL` | `https://api.binance.com` | Testnet: `https://testnet.binance.vision` |
| `BINANCE_SPOT_SYMBOL` | `SOLUSDT` | Пара Spot |
| `BINANCE_SPOT_MAX_QUOTE_USDT` | `20` | Потолок notional на один BUY |
| `MAX_NOTIONAL_USDT` | `20` | Верхний лимит (сайзинг по риску может быть меньше) |
| `RISK_PER_TRADE_PERCENT` | `1` | % эквити на риск в одной сделке |
| `SPOT_TAKER_FEE_PERCENT` | `0.1` | Комиссия Binance Spot на одну сторону |
| `MIN_NET_TP_PERCENT` | `0.3` | Минимальная чистая прибыль TP сверх 2×комиссии |
| `ATR_PERIOD` | `14` | Период ATR |
| `ATR_SL_MULT` / `ATR_TP_MULT` | `1.0` / `2.0` | Множители SL / TP от ATR |
| `ATR_TRAIL_ACTIVATION_MULT` | `1.0` | При профите в N×ATR активируется трейлинг |
| `ADX_MIN` | `20` | Порог ADX для торговли |
| `EMA_FAST` / `EMA_SLOW` / `EMA_LONG` | `20`/`50`/`200` | Периоды EMA (1h) |
| `RSI_ENTRY_MIN` / `RSI_ENTRY_MAX` | `40` / `65` | Коридор RSI для входа |
| `SWING_LOOKBACK_4H` | `12` | Свечей 4h для swing low |
| `GEMINI_ENABLED` | `false` | Включает AI-фильтр |
| `GEMINI_API_KEY` | — | [aistudio.google.com](https://aistudio.google.com/app/apikey) — бесплатный ключ |
| `GEMINI_MIN_CONFIDENCE` | `60` | Нижний порог уверенности Gemini |
| `GEMINI_CACHE_MS` | `600000` | TTL кэша решений (10 мин) |
| `MAX_CONSECUTIVE_LOSS_SELLS` | `5` | N убытков подряд → пауза |
| `LOSS_STREAK_COOLDOWN_MS` | `1800000` | Пауза 30 мин по умолчанию |
| `DAILY_MAX_LOSS_USDT` | `50` | Дневной стоп |
| `AUTO_TRADE_INTERVAL_MS` | `180000` | Тик автоторговли |
| `TRADING_WINDOW_UTC` | пусто | `08:00-21:00` или пусто |
| `TRADING_DAYS_UTC` | пусто | `1-5` или пусто |
| `STATS_EQUITY_BASELINE_USDT` | — | База для % прибыли в `/stats` |

Полный список — в [.env.example](.env.example).

---

## Telegram

- `/start`, `/menu` — меню.
- `/stats` — компактный баланс, прибыль день/неделя/30д с %, текущая позиция и WR.
- `/history` — последние сделки по одной строке.
- `/market SYMBOL` — статистика свечей 1h за 24h/7d/30d.
- `/autotrade on|off|status` — управление автоторговлей (админ).
- Кнопки: `📊 Статистика`, `📜 История`, `📦 Выгрузка JSON`, `▶️ / ⏹`.

Уведомления минималистичные:
```
🟢 Купил 0.226 SOL @ 88.37 (−19.97$)
🎯 Продал 0.226 SOL @ 89.25 +0.25$ / +1.26%
🛑 Продал 0.226 SOL @ 87.65 −0.16$ / −0.81%
📉 Продал 0.226 SOL @ 88.90 +0.12$ / +0.60%   (трейл)
⚠️ Продал 0.226 SOL @ 85.10 −0.66$ / −3.30%   (авария)
⏸️ Пауза 30м · 5 убытков подряд
```

---

## Получение ключей

- **Telegram**: [@BotFather](https://t.me/BotFather), `/newbot`.
- **Binance Spot**: `binance.com → API Management`. Для тестнета —
  [testnet.binance.vision](https://testnet.binance.vision) (логин через GitHub),
  разрешите **только** Spot Trading без вывода.
- **Gemini**: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey),
  бесплатный тариф покрывает 15 RPM / 1500 RPD.

---

## Команды для разработки

```bash
npm run lint           # eslint --fix
npm test               # jest
npm run build          # компиляция в dist/
npm run start:prod     # запуск из dist/
npx prisma migrate dev
npx prisma studio
```

---

## Почему не покупается прямо сейчас

Новая стратегия **отсеивает** шумовые сетапы. При боковике или контртренде 4h бот просто
ждёт — это нормально. Причины пропуска ищите в таблице `AuditLog` (действие `tick_skip*`)
и в логах сервиса.

---

## Лицензия

UNLICENSED / личное использование. Торговля криптовалютой сопряжена с риском потери средств.
