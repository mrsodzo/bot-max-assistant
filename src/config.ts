import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Загружаем переменные окружения из .env, расположенного рядом с корнем проекта.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Читает обязательную строковую переменную окружения.
 * Если переменная отсутствует или пустая — выбрасывает понятную ошибку.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  }
  return value.trim();
}

/**
 * Читает строковую переменную окружения с дефолтным значением.
 */
function getEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : defaultValue;
}

/**
 * Читает числовую переменную окружения с дефолтным значением.
 */
function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Переменная окружения ${name} должна быть числом, получено: ${value}`);
  }
  return parsed;
}

export const config = {
  botToken: requireEnv('BOT_TOKEN'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  webhookUrl: requireEnv('WEBHOOK_URL'),
  webhookSecret: requireEnv('WEBHOOK_SECRET'),
  port: getEnvNumber('PORT', 3000),
  dbPath: getEnv('DB_PATH', './data.db'),
  llmModel: getEnv('LLM_MODEL', 'claude-3-5-sonnet-20241022'),
} as const;

/**
 * Логирует сообщение с ISO-меткой времени.
 * Используется для входящих Update и исходящих ответов.
 */
export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
