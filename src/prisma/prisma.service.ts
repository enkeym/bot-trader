import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
    await this.ensureBotStateTable();
  }

  /** Если в образе не было prisma/migrations, migrate deploy не создаёт таблицы — не падаем на upsert. */
  private async ensureBotStateTable() {
    await this.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "BotState" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "autoTradeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyChatId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotState_pkey" PRIMARY KEY ("id")
);
`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
