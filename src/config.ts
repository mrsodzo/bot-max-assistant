import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Загружаем переменные окружения из .env, расположенного рядом с корнем проекта.
const __filename = fileURLToPath(import.meta.url);
// Ищем корень проекта: поднимаемся вверх от src/ (dev) или dist/src/ (prod)
// до первой директории, где лежит .env.
const __dirname = path.dirname(__filename);
let projectRoot = __dirname;
while (!fs.existsSync(path.join(projectRoot, '.env')) && path.dirname(projectRoot) !== projectRoot) {
  projectRoot = path.dirname(projectRoot);
}
dotenv.config({ path: path.resolve(projectRoot, '.env') });

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
  openaiApiKey: requireEnv('OPENAI_API_KEY'),
  openaiBaseUrl: getEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  openaiModel: getEnv('OPENAI_MODEL', 'gpt-4o-mini'),
  openaiTemperature: getEnvNumber('OPENAI_TEMPERATURE', 0.7),
  openaiMaxTokens: getEnvNumber('OPENAI_MAX_TOKENS', 2000),
  webhookUrl: requireEnv('WEBHOOK_URL'),
  webhookSecret: requireEnv('WEBHOOK_SECRET'),
  port: getEnvNumber('PORT', 3000),
  dbPath: getEnv('DB_PATH', './data.db'),
  transcriberUrl: getEnv('TRANSCRIBER_URL', 'http://localhost:8001'),
} as const;

/**
 * Логирует сообщение с ISO-меткой времени.
 * Используется для входящих Update и исходящих ответов.
 */
export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
