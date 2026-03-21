import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
    await this.ensureSchemaTables();
  }

  /**
   * Fallback, когда в контейнере не гоняют `prisma migrate deploy` (образ без миграций).
   * Создаёт таблицы и догоняет колонки через ADD COLUMN IF NOT EXISTS — иначе схема
   * из schema.prisma и реальная БД расходятся после каждого расширения модели.
   * Предпочтительно по-прежнему: `prisma migrate deploy` при старте/деплое.
   */
  private async ensureSchemaTables() {
    await this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "OrderIntent" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderIntent_pkey" PRIMARY KEY ("id")
)`);
      await tx.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
)`);
      await tx.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "TelegramUser" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "tonConnected" BOOLEAN NOT NULL DEFAULT false,
    "accessPaid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramUser_pkey" PRIMARY KEY ("id")
)`);
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "OrderIntent_idempotencyKey_key" ON "OrderIntent"("idempotencyKey")`,
      );
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "TelegramUser_telegramId_key" ON "TelegramUser"("telegramId")`,
      );
      await tx.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "BotState" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "autoTradeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyChatId" TEXT,
    "spotTrackedBtc" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "spotAvgEntryUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotState_pkey" PRIMARY KEY ("id")
)`);
      await tx.$executeRawUnsafe(
        `ALTER TABLE "BotState" ADD COLUMN IF NOT EXISTS "spotTrackedBtc" DECIMAL(18,8) NOT NULL DEFAULT 0`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "BotState" ADD COLUMN IF NOT EXISTS "spotAvgEntryUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0`,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "BotState" ADD COLUMN IF NOT EXISTS "spotRoundtripPeakMarkUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0`,
      );
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
