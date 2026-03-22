import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  validateSync,
} from 'class-validator';

export enum ExecutionMode {
  AUTO_EXCHANGE_ONLY = 'AUTO_EXCHANGE_ONLY',
  REQUIRE_HUMAN_BANK_CONFIRM = 'REQUIRE_HUMAN_BANK_CONFIRM',
}

class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @IsNumber()
  PORT?: number;

  @IsString()
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  @IsString()
  TELEGRAM_BOT_TOKEN!: string;

  @IsOptional()
  @IsString()
  BINANCE_API_KEY?: string;

  @IsOptional()
  @IsString()
  BINANCE_API_SECRET?: string;

  @IsOptional()
  @IsBoolean()
  DRY_RUN?: boolean;

  @IsEnum(ExecutionMode)
  EXECUTION_MODE!: ExecutionMode;

  @IsOptional()
  @IsString()
  P2P_PROVIDER?: string;

  @IsString()
  FIAT!: string;

  @IsString()
  ASSET!: string;

  @IsNumber()
  @Min(0)
  MIN_SPREAD_PERCENT!: number;

  @IsNumber()
  @Min(0)
  MAX_NOTIONAL_USDT!: number;

  @IsNumber()
  @Min(0)
  DAILY_MAX_LOSS_USDT!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  MAX_DAILY_SPOT_TRADES?: number;

  @IsNumber()
  @Min(0)
  P2P_TAKER_FEE_PERCENT!: number;

  @IsOptional()
  @IsString()
  TRADING_WINDOW_UTC?: string;

  @IsOptional()
  @IsString()
  TRADING_DAYS_UTC?: string;

  @IsOptional()
  @IsString()
  TON_CONNECT_MANIFEST_URL?: string;

  @IsOptional()
  @IsString()
  TON_PAYMENT_RECIPIENT?: string;

  @IsOptional()
  @IsBoolean()
  REQUIRE_TON_ACCESS?: boolean;
}

export function validateEnv(config: Record<string, unknown>) {
  const coerce: Record<string, unknown> = { ...config };
  if (coerce.EXECUTION_MODE == null)
    coerce.EXECUTION_MODE = ExecutionMode.AUTO_EXCHANGE_ONLY;
  if (coerce.FIAT == null) coerce.FIAT = 'USD';
  if (coerce.ASSET == null) coerce.ASSET = 'USDT';
  if (coerce.MIN_SPREAD_PERCENT == null) coerce.MIN_SPREAD_PERCENT = '0.15';
  if (coerce.MAX_NOTIONAL_USDT == null) coerce.MAX_NOTIONAL_USDT = '500';
  if (coerce.DAILY_MAX_LOSS_USDT == null) coerce.DAILY_MAX_LOSS_USDT = '50';
  if (coerce.P2P_TAKER_FEE_PERCENT == null) coerce.P2P_TAKER_FEE_PERCENT = '0';
  if (coerce.MAX_DAILY_SPOT_TRADES == null)
    coerce.MAX_DAILY_SPOT_TRADES = undefined;
  if (coerce.DRY_RUN == null) coerce.DRY_RUN = 'true';
  if (coerce.PORT !== undefined) coerce.PORT = Number(coerce.PORT);
  if (coerce.DRY_RUN !== undefined)
    coerce.DRY_RUN =
      coerce.DRY_RUN === true ||
      coerce.DRY_RUN === 'true' ||
      coerce.DRY_RUN === '1';
  if (coerce.REQUIRE_TON_ACCESS !== undefined)
    coerce.REQUIRE_TON_ACCESS =
      coerce.REQUIRE_TON_ACCESS === true ||
      coerce.REQUIRE_TON_ACCESS === 'true' ||
      coerce.REQUIRE_TON_ACCESS === '1';
  const numeric = [
    'MIN_SPREAD_PERCENT',
    'MAX_NOTIONAL_USDT',
    'DAILY_MAX_LOSS_USDT',
    'P2P_TAKER_FEE_PERCENT',
  ] as const;
  for (const k of numeric) {
    if (coerce[k] !== undefined) coerce[k] = Number(coerce[k]);
  }
  if (coerce.MAX_DAILY_SPOT_TRADES !== undefined)
    coerce.MAX_DAILY_SPOT_TRADES = Number(coerce.MAX_DAILY_SPOT_TRADES);

  const validated = plainToInstance(EnvironmentVariables, coerce, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });
  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validated;
}
