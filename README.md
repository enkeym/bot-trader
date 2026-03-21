# Trader — Telegram-бот (Binance P2P + TON Connect)

Сервер на **Node.js + NestJS + TypeScript**: мониторинг стакана **Binance P2P** (пара **USDT/RUB**), расчёт спреда, **симуляция** сделок при `DRY_RUN=true`, уведомления и команды в **Telegram**, опционально **TON Connect** (манифест, ограничение доступа к командам). Данные — **PostgreSQL**, опционально **Redis** (кэш для антиспама алертов).

> **Важно.** Для **чтения** стакана P2P используется **публичный** API (без ключей). При `DRY_RUN=false` и заданных **API-ключах** с [Binance](https://www.binance.com) бот отправляет **Spot MARKET-ордера** на продакшен API (`api.binance.com`). Это **реальные** средства. P2P-сделки по API здесь **не** автоматизируются. Соблюдайте [правила Binance](https://www.binance.com/en/terms) и местное законодательство.

---

## Содержание

1. [Что умеет бот](#что-умеет-бот)
2. [Бумажная симуляция прибыли](#бумажная-симуляция-прибыли)
3. [Что нужно заранее](#что-нужно-заранее)
4. [Установка и запуск (локально)](#установка-и-запуск-локально)
5. [Получение токена Telegram-бота](#получение-токена-telegram-бота)
6. [Ключи API Binance (опционально)](#ключи-api-binance-опционально)
7. [PostgreSQL и миграции](#postgresql-и-миграции)
8. [Redis (опционально)](#redis-опционально)
9. [Переменные окружения (.env)](#переменные-окружения-env)
10. [TON Connect и HTTPS](#ton-connect-и-https)
11. [Алерты в Telegram (chat id)](#алерты-в-telegram-chat-id)
12. [Команды бота](#команды-бота)
13. [Продакшен](#продакшен)
14. [Частые проблемы](#частые-проблемы)
15. [Дополнительная документация](#дополнительная-документация)

---

## Что умеет бот

| Функция | Описание |
|--------|----------|
| Мониторинг спреда | Запрос к публичному API Binance P2P, лучшие цены покупки/продажи USDT за RUB, грубый и «чистый» спред (с учётом `P2P_TAKER_FEE_PERCENT`). |
| Симуляция | При прохождении риск-лимитов запись **идемпотентного** `OrderIntent` в БД (без реальной сделки на бирже при `DRY_RUN=true`). |
| Telegram | `/start` — меню с кнопками (статистика; для админа — вкл/выкл автоторговли); уведомления о сделках; cron-алерты по спреду. |
| HTTP | `GET /health` — проверка живости; `GET /tonconnect-manifest.json` — манифест TON Connect. |

Режимы исполнения и ограничения P2P описаны в [docs/MVP.md](docs/MVP.md).

---

## Бумажная симуляция прибыли

**Подключать реальный TON Wallet или Binance для этого не нужно.** Достаточно `DRY_RUN=true`, Postgres и токена Telegram-бота.

Стратегия при **автоторговле** или ручном срабатывании: стакан Binance P2P, риск-лимиты, при успехе — запись в БД (`SIMULATED` при `DRY_RUN=true`) или Spot-ордер при `DRY_RUN=false`. Оценка прибыли в USDT: **notional × (чистый спред % / 100)** — упрощённая модель. Сводка по бумаге и Spot — в **`/статистика`**.

Цифры **не являются** финансовой гарантией и не заменяют реальный P&amp;L на бирже.

---

## Что нужно заранее

- **Node.js** 20+ и **npm**
- **Docker** и Docker Compose (для PostgreSQL и при желании Redis)
- Аккаунт **Telegram** и возможность написать [@BotFather](https://t.me/BotFather)
- Для продакшена с TON: **публичный HTTPS**-URL вашего сервера (манифест TON Connect должен открываться по HTTPS)

---

## Установка и запуск (локально)

```bash
cd trader   # корень проекта

# 1. Зависимости
npm install

# 2. Окружение
cp .env.example .env
# Отредактируйте .env — минимум DATABASE_URL и TELEGRAM_BOT_TOKEN (см. ниже)

# 3. База данных
docker compose up -d postgres

# 4. Применить схему Prisma
npx prisma migrate dev

# 5. Запуск в режиме разработки
npm run start:dev
```

**Через Makefile** (из корня `trader/`):

| Команда | Действие |
|--------|----------|
| `make help` | Список всех целей |
| `make up` | **Весь стек в Docker:** Postgres + Redis + **Nest в контейнере `bot-trader`** (`docker compose up -d --build`) — для **сервера** |
| `make infra` | Только Postgres + Redis (под **локальный** `npm run start:dev`) |
| `make down` | Остановить контейнеры (volumes не трогает) |
| `make restart` | Перезапустить контейнеры |
| `make rebuild` | Обновить образы и пересоздать контейнеры |
| `make destroy` | Остановить и **удалить volumes** (БД обнулится) |
| `make dev` | Nest в watch на хосте (БД должна быть запущена, см. `make infra`) |
| `make start` | `infra` → пауза → `prisma migrate deploy` → `npm run start:dev` (**бот не в Docker**) |
| `make migrate` / `make migrate-dev` | Миграции Prisma |

Перед `make start`: `cp .env.example .env`, `make install`, для продакшена в Docker — **`make up`** и заполненный `.env`.

По умолчанию HTTP-сервер слушает порт из `PORT` (часто **3000**). Проверка: в браузере или `curl` откройте `http://localhost:3000/health` — ожидается JSON с `"ok": true`.

Остановка Docker:

```bash
docker compose down
# или
make down
```

---

## Получение токена Telegram-бота

1. Откройте Telegram и найдите **[@BotFather](https://t.me/BotFather)**.
2. Отправьте `/newbot` и следуйте инструкциям: имя бота и **username** (должен заканчиваться на `bot`).
3. BotFather выдаст **токен** вида `123456789:AAH...` — это секрет; никому не показывайте и не коммитьте в git.
4. Вставьте токен в `.env`:

   ```env
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   ```

5. Перезапустите приложение (`npm run start:dev` или процесс в PM2/systemd).

После запуска бот будет отвечать на команды в Telegram (если `NODE_ENV` не равен `test` — в тестах бот намеренно не стартует).

---

## Ключи API Binance (опционально)

### Нужны ли они сейчас?

- **Нет**, если вы только смотрите спред и включаете **симуляцию** с `DRY_RUN=true` — используется **публичный** endpoint поиска объявлений P2P, ключи не передаются.
- **Да**, для **Spot** создайте ключи в аккаунте Binance → **API Management**, укажите в `.env` `BINANCE_API_KEY` / `BINANCE_API_SECRET`, выставьте `DRY_RUN=false`. Исполнение — **рыночный ордер** по паре `BINANCE_SPOT_SYMBOL` (по умолчанию `BTCUSDT`); сигнал стратегии — по **P2P-спреду** USDT/RUB и риск-фильтру (это не арбитраж Spot↔P2P).

### Как создать API Key на Binance

Точные пункты меню могут меняться; ориентируйтесь на актуальный интерфейс [Binance](https://www.binance.com):

1. Войдите в аккаунт, пройдите **верификацию** (KYC), включите **2FA** (Google Authenticator и т.д.).
2. Перейдите в раздел **API Management** (Управление API).
3. Создайте новый API Key; при необходимости задайте **ограничение по IP** (рекомендуется для сервера с фиксированным IP).
4. Права (permissions): включайте **только то, что нужно**. Для вывода средств (`Enable Withdrawals`) — по возможности **не включайте**, если в этом нет жёсткой необходимости.
5. Сохраните **API Key** и **Secret** один раз — Secret показывается только при создании.

В `.env`:

```env
BINANCE_API_KEY=ваш_api_key
BINANCE_API_SECRET=ваш_secret
```

База Spot по умолчанию — `https://api.binance.com`. Ключи с **Spot Testnet** ([testnet.binance.vision](https://testnet.binance.vision)) работают только с `BINANCE_SPOT_BASE_URL=https://testnet.binance.vision` — иначе Binance вернёт −2015 «Invalid API-key…». Шаблон — [.env.example](.env.example).

**Безопасность:**

- Не храните ключи в репозитории; используйте `.env` на сервере, секреты CI/CD, Vault и т.п.
- Регулярно **ротируйте** ключи при компрометации.
- Проверяйте [официальную документацию Binance API](https://binance-docs.github.io/apidocs/spot/en/) и условия использования P2P/C2C.

---

## PostgreSQL и миграции

Строка подключения задаётся в **`DATABASE_URL`**. Для стека из `docker-compose.yml` по умолчанию:

```env
DATABASE_URL=postgresql://trader:trader@localhost:5432/trader
```

После изменения `prisma/schema.prisma`:

```bash
npx prisma migrate dev
```

Только генерация клиента без миграций:

```bash
npm run prisma:generate
```

---

## Redis (опционально)

Поднять Redis из того же `docker-compose.yml`:

```bash
docker compose up -d redis
```

Порт Redis **наружу не пробрасывается** — сервис доступен только контейнерам в этой сети Compose (как и Postgres без `ports`). Контейнер `bot-trader` уже получает `REDIS_URL=redis://redis:6379` из `docker-compose.yml`.

**Nest на хосте** (`npm run start:dev` + `make infra`): из `.env` до такого Redis **не достучаться** по `localhost`. Варианты:

- оставить `REDIS_URL` **пустым** — один процесс на машине, дедуп Telegram и антиспам алертов только в памяти процесса;
- поднять Redis **на хосте** отдельно и указать, например, `REDIS_URL=redis://127.0.0.1:6379`;
- для себя локально добавить не в git `docker-compose.override.yml` с `ports` у `redis` (только если осознанно нужен доступ с хоста).

Если `REDIS_URL` **пустой**, бот работает без Redis; антиспам для cron-алертов по спреду использует **память процесса** (менее надёжно при нескольких инстансах).

Если в `.env` указан `REDIS_URL`, но до Redis **нет сетевого доступа** (частый случай: `127.0.0.1`, а Redis только в Docker без проброса), в логах будет ошибка подключения; либо поправьте URL/инфраструктуру, либо **очистите** `REDIS_URL`, пока Redis не нужен.

---

## Переменные окружения (.env)

Полный шаблон — в [.env.example](.env.example). Кратко:

| Переменная | Назначение |
|------------|------------|
| `DATABASE_URL` | Подключение к PostgreSQL |
| `TELEGRAM_BOT_TOKEN` | Токен от BotFather (**обязателен** для работы бота) |
| `PORT` | Порт HTTP (по умолчанию 3000) |
| `REDIS_URL` | Опционально, Redis |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Ключи Spot из [Binance API Management](https://www.binance.com/en/my/settings/api-management) |
| `BINANCE_SPOT_BASE_URL` | Продакшен: `https://api.binance.com` (по умолчанию). Testnet-ключи: `https://testnet.binance.vision` |
| `BINANCE_SPOT_SYMBOL`, `BINANCE_SPOT_ORDER_SIDE`, `BINANCE_SPOT_MAX_QUOTE_USDT`, `BINANCE_SPOT_QUANTITY` | Параметры MARKET-ордера (см. [.env.example](.env.example)) |
| `DRY_RUN` | `true` — только запись `SIMULATED` в БД; `false` — при прохождении риска и наличии ключей — Spot API |
| `EXECUTION_MODE` | `AUTO_EXCHANGE_ONLY` или `REQUIRE_HUMAN_BANK_CONFIRM` — см. [docs/MVP.md](docs/MVP.md) |
| `P2P_PROVIDER` | Сейчас поддерживается `binance` |
| `FIAT` / `ASSET` | Например `RUB` и `USDT` |
| `MIN_SPREAD_PERCENT` | Минимальный спред для риск-фильтра |
| `MAX_NOTIONAL_USDT` | Верхняя граница объёма в логике риска (USDT) |
| `DAILY_MAX_LOSS_USDT` | Зарезервировано под дневные лимиты (расширение логики) |
| `P2P_TAKER_FEE_PERCENT` | Оценка комиссии для «чистого» спреда |
| `PUBLIC_BASE_URL` | Базовый URL приложения (для текста команды `/connect`) |
| `TON_CONNECT_MANIFEST_URL` | URL манифеста для кошельков (часто совпадает с `PUBLIC_BASE_URL/tonconnect-manifest.json` на проде) |
| `TON_PAYMENT_RECIPIENT` | Опционально, адрес для платежей в TON |
| `REQUIRE_TON_ACCESS` | `true` — часть команд только при `accessPaid` у пользователя в БД |
| `TELEGRAM_ALERT_CHAT_ID` | Опционально, куда слать алерты о спреде |
| `ADMIN_TELEGRAM_IDS` | Список user id через запятую; обход `REQUIRE_TON_ACCESS` |

Валидация части переменных при старте — в [src/config/env.validation.ts](src/config/env.validation.ts).

---

## TON Connect и HTTPS

1. Манифест отдаётся приложением: **`GET /tonconnect-manifest.json`** (см. [src/ton/ton.controller.ts](src/ton/ton.controller.ts)).
2. Для реальных кошельков URL манифеста должен быть доступен по **HTTPS** с валидным сертификатом.
3. Укажите публичный URL в `TON_CONNECT_MANIFEST_URL` и согласуйте с `PUBLIC_BASE_URL` (например `https://bot.example.com` и `https://bot.example.com/tonconnect-manifest.json`).
4. Команда `/connect` в Telegram подсказывает пользователю ссылку на манифест.

Подробнее о роли TON в проекте — в [docs/MVP.md](docs/MVP.md).

---

## Алерты в Telegram (chat id)

Чтобы cron присылал сообщения о высоком спреде:

1. Напишите боту [@userinfobot](https://t.me/userinfobot) или [@getidsbot](https://t.me/getidsbot) и узнайте свой **числовой id** (для личных чатов) или id группы (для групп бот должен быть добавлен).
2. Укажите в `.env`:

   ```env
   TELEGRAM_ALERT_CHAT_ID=123456789
   ```

3. Перезапустите приложение. Алерты не чаще одного раза в ~10 минут на один и тот же сценарий (Redis или память).

---

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Текст + **постоянная клавиатура**: «Статистика»; для пользователей из `ADMIN_TELEGRAM_IDS` — «Включить/Выключить автоторговлю» |
| `/menu` | Снова показать клавиатуру |
| `/статистика` или `/stats` | Сводка: режим, баланс, оценки, последние операции |
| `/autotrade on\|off\|status` | То же, что кнопки (только админ). Интервал тика: `AUTO_TRADE_INTERVAL_MS` |

**P2P** (объявления, банковские переводы) по API **не** автоматизируются. **Spot** — подписанные MARKET-ордера при `DRY_RUN=false` и заданных API-ключах.

**Дубли ответов на одну команду** почти всегда значат: запущено **два процесса** с одним `TELEGRAM_BOT_TOKEN` (два контейнера, PM2 `instances > 1`, `nest --watch` на пару секунд с двумя воркерами, бот в Docker и тот же токен локально). Оставьте **один** инстанс бота. Если нужно несколько реплик — задайте **рабочий** `REDIS_URL` к общему Redis: бот дедуплицирует `update_id` через `SET NX`. Если Redis в compose **без** проброса порта, с хоста указывать `redis://127.0.0.1:6379` бессмысленно — дедуп снова только внутри процесса, и два инстанса дадут дубли. При старте приложение делает `PING` в Redis и пишет в лог, удалось ли подключиться.

Если `REQUIRE_TON_ACCESS=true`, для команд (кроме сценария с админами) может потребоваться флаг оплаты в БД — см. модель `TelegramUser` и [docs/SECRETS_AND_AUDIT.md](docs/SECRETS_AND_AUDIT.md).

---

## Продакшен

### Вариант A: всё в Docker (стек `bot-trader`)

Проект в Compose называется **`bot-trader`**, контейнер приложения — **`bot-trader`**, образ собирается из [Dockerfile](Dockerfile).

1. На сервере: скопируйте проект, создайте **`.env`** (из [.env.example](.env.example)), обязательно **`TELEGRAM_BOT_TOKEN`**, **`ADMIN_TELEGRAM_IDS`**, при необходимости **`POSTGRES_PASSWORD`** (тогда же поменяйте пользователя/пароль в `docker-compose.yml` в блоке `environment` сервиса `bot-trader` для `DATABASE_URL` и в `postgres` — или оставьте дефолты `trader` только для теста).
2. В `.env` для продакшена укажите **`PUBLIC_BASE_URL`** и **`TON_CONNECT_MANIFEST_URL`** с **HTTPS**-доменом (не `localhost`).
3. Запуск всего стека (образ приложения + миграции при старте контейнера):

   ```bash
   make up
   ```

4. Снаружи публикуется порт **`APP_PORT`** (по умолчанию **3000**) → проброс на контейнер `bot-trader`. За **Nginx/Caddy** с TLS проксируйте на `127.0.0.1:3000`.
5. Внутри сети Compose **`DATABASE_URL` и `REDIS_URL` подставляются автоматически** (хосты `postgres` и `redis`). Не дублируйте в `.env` `localhost` для этих переменных при запуске **в Docker** — иначе приложение не достучится до БД.

Логи: `docker compose logs -f bot-trader`. Остановка: `make down`.

**Локальная разработка с кодом на хосте:** `make infra` — только **Postgres + Redis**; затем `npm run start:dev` или `make start`.

### Вариант B: Node на хосте, БД в Docker

1. `make infra` — только Postgres + Redis.  
2. В `.env` — `DATABASE_URL=postgresql://trader:trader@localhost:5432/trader`.  
3. `npm run build` → `npm run start:prod`.

### Общее

- Храните секреты вне репозитория; ограничьте доступ к серверу и БД.  
- Резервное копирование тома **`pgdata`** (PostgreSQL).

---

## Частые проблемы

| Симптом | Что проверить |
|--------|----------------|
| Бот не отвечает | Токен в `.env`, второй процесс с тем же ботом. В логах должны быть строки `Telegram: onApplicationBootstrap` и `Telegram: polling OK`. Если их нет — хост/сеть блокирует **api.telegram.org** (нужен VPN/другой маршрут для Docker). |
| Ошибка подключения к БД | Запущен ли `docker compose up -d postgres`, верный ли `DATABASE_URL` |
| Prisma P1001 | PostgreSQL недоступен по хосту/порту |
| Нет сделок / пустой стакан в логике стратегии | Для пары **USDT/RUB** иногда нет объявлений (регион/IP). Временно **`FIAT=USD`** в `.env`, перезапуск. |
| Таймаут / ошибка соединения при `curl` | Сеть, файрвол, DNS; иной VPN. |
| TON не подключается | Манифест только по HTTPS, корректный `TON_CONNECT_MANIFEST_URL` |

---

## Дополнительная документация

- [docs/EXCHANGE_API.md](docs/EXCHANGE_API.md) — API Binance P2P в контексте проекта  
- [docs/MVP.md](docs/MVP.md) — режимы `DRY_RUN`, исполнение, банковский шаг  
- [docs/SECRETS_AND_AUDIT.md](docs/SECRETS_AND_AUDIT.md) — секреты, аудит, идемпотентность  

---

## Скрипты npm

| Скрипт | Назначение |
|--------|------------|
| `npm run start:dev` | Разработка с hot-reload |
| `npm run start:prod` | Запуск собранного `dist/` |
| `npm run build` | Сборка |
| `npm test` / `npm run test:e2e` | Тесты |
| `npm run lint` | ESLint |
| `npm run prisma:generate` | Генерация Prisma Client |
| `npm run prisma:migrate` | Миграции (dev) |

---

## Лицензия

Private / UNLICENSED — использование на свой страх и риск; авторы не несут ответственности за торговые и юридические последствия.
# bot-trader
