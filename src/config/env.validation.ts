import { plainToInstance } from 'class-transformer';
import {
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

  @IsEnum(ExecutionMode)
  EXECUTION_MODE!: ExecutionMode;

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

  @IsOptional()
  @IsNumber()
  @Min(0)
  SPOT_TAKER_FEE_PERCENT?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  RISK_PER_TRADE_PERCENT?: number;

  @IsOptional()
  @IsString()
  TRADING_WINDOW_UTC?: string;

  @IsOptional()
  @IsString()
  TRADING_DAYS_UTC?: string;

  @IsOptional()
  @IsString()
  GEMINI_API_KEY?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const coerce: Record<string, unknown> = { ...config };
  if (coerce.EXECUTION_MODE == null)
    coerce.EXECUTION_MODE = ExecutionMode.AUTO_EXCHANGE_ONLY;
  if (coerce.MAX_NOTIONAL_USDT == null) coerce.MAX_NOTIONAL_USDT = '20';
  if (coerce.DAILY_MAX_LOSS_USDT == null) coerce.DAILY_MAX_LOSS_USDT = '50';
  if (coerce.MAX_DAILY_SPOT_TRADES == null)
    coerce.MAX_DAILY_SPOT_TRADES = undefined;
  if (coerce.SPOT_TAKER_FEE_PERCENT == null)
    coerce.SPOT_TAKER_FEE_PERCENT = '0.1';
  if (coerce.RISK_PER_TRADE_PERCENT == null)
    coerce.RISK_PER_TRADE_PERCENT = '1';
  if (coerce.PORT !== undefined) coerce.PORT = Number(coerce.PORT);

  const numeric = [
    'MAX_NOTIONAL_USDT',
    'DAILY_MAX_LOSS_USDT',
    'SPOT_TAKER_FEE_PERCENT',
    'RISK_PER_TRADE_PERCENT',
  ] as const;
  for (const k of numeric) {
    if (coerce[k] !== undefined) coerce[k] = Number(coerce[k]);
  }
  if (coerce.MAX_DAILY_SPOT_TRADES !== undefined)
    coerce.MAX_DAILY_SPOT_TRADES = Number(coerce.MAX_DAILY_SPOT_TRADES);

  const validated = plainToInstance(EnvironmentVariables, coerce, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validated;
}
