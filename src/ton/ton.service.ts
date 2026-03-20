import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAIN } from '@tonconnect/sdk';

/**
 * Минимальная обвязка TON Connect: манифест и проверка флага доступа в БД.
 * `@tonconnect/sdk` подключён для типов сети; UI-кошелёк обычно в Mini App.
 */
@Injectable()
export class TonService {
  constructor(private readonly config: ConfigService) {}

  getManifestBody() {
    const base =
      this.config.get<string>('ton.manifestUrl') ?? 'https://example.com';
    return {
      url: base.replace(/\/$/, ''),
      name: 'Trader P2P Bot',
      iconUrl: 'https://ton.org/download/ton_symbol.png',
    };
  }

  getPaymentRecipient(): string | undefined {
    return this.config.get<string>('ton.paymentRecipient');
  }

  isAccessRequired(): boolean {
    return this.config.get<boolean>('ton.requireAccess') === true;
  }

  /** Целевая сеть для TON Connect (mainnet). */
  getDefaultChain() {
    return CHAIN.MAINNET;
  }
}
