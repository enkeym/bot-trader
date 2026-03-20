import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrderIntentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Создание намерения сделки с идемпотентностью по ключу.
   * Повтор с тем же ключом возвращает существующую запись без изменений.
   */
  async createIdempotent(params: {
    idempotencyKey: string;
    provider: string;
    side: string;
    status: string;
    payload?: Record<string, unknown>;
  }) {
    const existing = await this.prisma.orderIntent.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) {
      return { record: existing, created: false };
    }

    try {
      const record = await this.prisma.orderIntent.create({
        data: {
          idempotencyKey: params.idempotencyKey,
          provider: params.provider,
          side: params.side,
          status: params.status,
          payload: params.payload
            ? (params.payload as Prisma.InputJsonValue)
            : undefined,
        },
      });
      return { record, created: true };
    } catch (e: unknown) {
      const code =
        e && typeof e === 'object' && 'code' in e
          ? (e as { code?: string }).code
          : undefined;
      if (code === 'P2002') {
        const record = await this.prisma.orderIntent.findUniqueOrThrow({
          where: { idempotencyKey: params.idempotencyKey },
        });
        return { record, created: false };
      }
      throw e;
    }
  }
}
