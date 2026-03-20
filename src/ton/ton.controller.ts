import { Controller, Get } from '@nestjs/common';
import { TonService } from './ton.service';

@Controller()
export class TonController {
  constructor(private readonly ton: TonService) {}

  /** TON Connect manifest (HTTPS URL этого эндпоинта задаётся в TON_CONNECT_MANIFEST_URL). */
  @Get('tonconnect-manifest.json')
  manifest() {
    return this.ton.getManifestBody();
  }
}
