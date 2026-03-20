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
   * Если в образе не было prisma/migrations, migrate deploy не создаёт таблицы.
   * Дублирует init + bot_state миграции через IF NOT EXISTS (идемпотентно).
   * Одна инструкция на вызов — ограничение Prisma $executeRaw.
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
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotState_pkey" PRIMARY KEY ("id")
)`);
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
