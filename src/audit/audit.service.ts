import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(
    level: 'info' | 'warn' | 'error',
    action: string,
    meta?: Record<string, unknown>,
  ) {
    const line = { action, ...meta };
    if (level === 'error') this.logger.error(JSON.stringify(line));
    else if (level === 'warn') this.logger.warn(JSON.stringify(line));
    else this.logger.log(JSON.stringify(line));

    try {
      await this.prisma.auditLog.create({
        data: {
          level,
          action,
          meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (e) {
      this.logger.error(`audit persist failed: ${e}`);
    }
  }
}
