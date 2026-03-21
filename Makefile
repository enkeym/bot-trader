# Trader — Docker (Postgres/Redis) + NestJS бот
# Требуется: Docker, Node 20+, npm. Скопируйте .env из .env.example.

.PHONY: help up infra down restart rebuild destroy logs ps \
	install build dev prod start app \
	migrate migrate-dev prisma-generate \
	clean clean-all lint test

COMPOSE := docker compose
SLEEP_DB := sleep 3

help:
	@echo "Trader — команды"
	@echo ""
	@echo "  Docker (сервер / прод):"
	@echo "    make up          — весь стек: Postgres + Redis + Nest в контейнере bot-trader (--build)"
	@echo "    make infra       — только Postgres + Redis (локально под npm run start:dev)"
	@echo "    make down        — остановить контейнеры (данные в volume сохраняются)"
	@echo "    make restart     — перезапустить контейнеры"
	@echo "    make rebuild     — pull образов и пересоздать контейнеры"
	@echo "    make destroy     — остановить и УДАЛИТЬ volumes (БД будет пустой!)"
	@echo "    make logs        — логи контейнеров (follow)"
	@echo "    make ps          — статус контейнеров"
	@echo ""
	@echo "  Приложение:"
	@echo "    make install     — npm install"
	@echo "    make dev         — только nest --watch (БД уже доступна по DATABASE_URL)"
	@echo "    make start       — Docker: postgres+redis + миграции + start:dev (нужен docker compose)"
	@echo "    make app         — без Docker: миграции + start:dev (PostgreSQL по DATABASE_URL в .env)"
	@echo "    make prod        — build + start:prod"
	@echo "    make build       — nest build"
	@echo ""
	@echo "  База (Prisma):"
	@echo "    make migrate     — prisma migrate deploy (применить миграции, CI/прод)"
	@echo "    make migrate-dev — prisma migrate dev (разработка, создание миграций)"
	@echo "    make prisma-generate — только сгенерировать клиент"
	@echo ""
	@echo "  Прочее:"
	@echo "    make clean       — удалить dist/"
	@echo "    make clean-all   — clean + node_modules/"
	@echo "    make lint        — eslint"
	@echo "    make test        — jest"

# --- Docker ---

up:
	@$(COMPOSE) up -d --build

infra:
	@$(COMPOSE) up -d postgres redis

down:
	@$(COMPOSE) down

restart:
	@$(COMPOSE) restart

rebuild:
	@$(COMPOSE) pull
	@$(COMPOSE) up -d --force-recreate

destroy:
	@$(COMPOSE) down -v

logs:
	@$(COMPOSE) logs -f

ps:
	@$(COMPOSE) ps

# --- App ---

install:
	@npm install

build:
	@npm run build

dev:
	@npm run start:dev

prod: build
	@npm run start:prod

start: infra
	@echo "Ожидание Postgres..."
	@$(SLEEP_DB)
	@npx prisma migrate deploy
	@npm run start:dev

# Без Docker: PostgreSQL (и при необходимости Redis) вы поднимаете сами; строки в .env
app:
	@npx prisma migrate deploy
	@npm run start:dev

migrate:
	@npx prisma migrate deploy

migrate-dev:
	@npx prisma migrate dev

prisma-generate:
	@npm run prisma:generate

# --- Clean ---

clean:
	@rm -rf dist

clean-all: clean
	@rm -rf node_modules

lint:
	@npm run lint

test:
	@npm test
