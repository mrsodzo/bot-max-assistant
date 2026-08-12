import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { config, log } from './config.js';

/**
 * Системный промпт ассистента — задаёт роль и стиль общения в групповом чате Max.
 */
export const SYSTEM_PROMPT = `Ты — персональный ассистент в групповом чате мессенджера Max. Твоя задача — помогать участникам чата экономить время и не терять важную информацию в потоке сообщений. Пиши на русском языке, если не указано иное. Форматируй ответы под мессенджер: короткие абзацы, умеренно эмодзи для структуры, без markdown-таблиц и сложной разметки. Не упоминай, что ты языковая модель, если не спрашивают напрямую. Уважай приватность: не сохраняй и не пересказывай личные данные (телефоны, адреса, финансовую информацию), маскируй их как [скрыто]. При неоднозначных или потенциально конфликтных ситуациях в чате — не занимай сторону, оставайся нейтральным.`;

/** Максимальное число попыток внешнего вызова (Anthropic/Whisper). */
const MAX_ATTEMPTS = 3;
/** Базовые задержки backoff для повторных попыток (мс): экспоненциальный рост. */
const BACKOFF_DELAYS_MS = [500, 1000, 2000];

let anthropicClient: Anthropic | null = null;

/**
 * Лениво создаёт клиент Anthropic.
 * Если API-ключ отсутствует — выбрасывает понятную ошибку при первом вызове,
 * чтобы бот продолжал обрабатывать остальные сценарии.
 */
function getAnthropic(): Anthropic {
  if (anthropicClient) {
    return anthropicClient;
  }
  if (!config.anthropicApiKey || config.anthropicApiKey.trim().length === 0) {
    throw new Error('ANTHROPIC_API_KEY не задан: функция LLM недоступна. Установите ANTHROPIC_API_KEY в .env');
  }
  // maxRetries: 0 — собственный retry/backoff реализован в anthropicComplete.
  anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 });
  return anthropicClient;
}

/**
 * Определяет, является ли ошибка повторимой (429 / 5xx / сетевая).
 * 4xx (кроме 429) не повторяем — это устойчивые ошибки запроса.
 */
function isRetriableError(error: unknown): boolean {
  // Сетевые ошибки (нет ответа) повторяемы.
  if (error instanceof APIError && (error as APIError).status === undefined) {
    return true;
  }
  if (error instanceof APIError) {
    const status = error.status;
    return status === 429 || (typeof status === 'number' && status >= 500);
  }
  return false;
}

/**
 * Sleep-обёртка для backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Общая внутренняя функция вызова Anthropic Messages API с retry/backoff.
 *
 * При 429/5xx повторяет до MAX_ATTEMPTS с задержками BACKOFF_DELAYS_MS.
 * При 4xx (кроме 429) — пробрасывает понятную ошибку без повторных попыток.
 * Финальная ошибка пробрасывается в вызывающий хендлер.
 */
async function anthropicComplete(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number } = {},
): Promise<string> {
  const maxTokens = options.maxTokens ?? 1024;
  const client = getAnthropic();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const start = Date.now();
    try {
      const response = await client.messages.create({
        model: config.llmModel,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const elapsed = Date.now() - start;
      log(`Anthropic OK: model=${config.llmModel}, attempt=${attempt}, ${elapsed}ms, stop=${response.stop_reason}`);

      // Извлекаем текст из блока(ов) ответа.
      return extractText(response);
    } catch (error) {
      const elapsed = Date.now() - start;
      if (!isRetriableError(error) || attempt === MAX_ATTEMPTS) {
        // Не повторяем: 4xx (кроме 429) или все попытки исчерпаны.
        const detail = formatAnthropicError(error);
        log(`Anthropic FAIL: attempt=${attempt}, ${elapsed}ms — ${detail}`);
        throw new Error(`Ошибка Anthropic API: ${detail}`);
      }
      // Повторяемая ошибка — ждём backoff и идём на следующую попытку.
      const backoffMs = BACKOFF_DELAYS_MS[attempt - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
      const detail = formatAnthropicError(error);
      log(`Anthropic RETRY: attempt=${attempt} failed (${detail}), ждём ${backoffMs}мс перед попыткой ${attempt + 1}`);
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }
  }
  // Теоретически недостижимо, но TS не знает о throw внутри цикла.
  throw new Error('Ошибка Anthropic API: все попытки исчерпаны');
}

/**
 * Извлекает текстовую часть ответа Anthropic.
 * Поддерживает массив блоков ContentBlock; возвращает конкатенацию text-блоков.
 */
function extractText(response: Anthropic.Messages.Message): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Форматирует ошибку Anthropic в человекочитаемую строку (статус + сообщение).
 */
function formatAnthropicError(error: unknown): string {
  if (error instanceof APIError) {
    const status = error.status ?? 'no-status';
    const message = error.message ?? 'неизвестная ошибка';
    return `HTTP ${status}: ${message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Краткое резюме (1-2 предложения) расшифровки голосового сообщения.
 * Используется в шаге 3 при обработке голосовых.
 */
export async function summarizeTranscript(transcript: string): Promise<string> {
  const userPrompt = `Сделай краткое резюме этой расшифровки голосового сообщения в 1-2 предложения на русском: ${transcript}`;
  return anthropicComplete(SYSTEM_PROMPT, userPrompt, { maxTokens: 256 });
}

/**
 * Перевод произвольного текста на русский язык с автоопределением исходного языка.
 * Если текст уже на русском — возвращает его с пометкой в начале.
 */
export async function translate(text: string): Promise<string> {
  const userPrompt = `Переведи на русский язык, сохранив тон и стиль. Если текст уже на русском — верни его с пометкой в начале. Верни только перевод без пояснений: ${text}`;
  return anthropicComplete(SYSTEM_PROMPT, userPrompt, { maxTokens: 1024 });
}

/**
 * Структурированное саммари обсуждения по темам с отдельным блоком явных договорённостей.
 * Сообщения передаются в порядке возрастания времени.
 */
export async function summarizeChat(messages: { sender_name?: string | null; text: string; timestamp: number }[]): Promise<string> {
  const formatted = messages
    .map((m) => {
      const sender = m.sender_name ? m.sender_name : 'Аноним';
      return `[${sender}] ${m.text}`;
    })
    .join('\n');
  const userPrompt = `Сделай структурированное саммари обсуждения ниже по темам. В конце отдельным блоком выдели явные договорённости/решения. Сообщения:\n${formatted}`;
  return anthropicComplete(SYSTEM_PROMPT, userPrompt, { maxTokens: 1024 });
}

// ---------------------------------------------------------------------------
// GigaAM Multilingual (Сбер): локальный сервис транскрибации через FastAPI.
// ---------------------------------------------------------------------------

const TRANSCRIBER_URL = config.transcriberUrl;
const TRANSCRIBER_TIMEOUT_MS = 120_000;

/**
 * Транскрибирует аудио в текст через локальный сервис GigaAM Multilingual.
 *
 * - multipart/form-data: file (Blob с filename + mimeType)
 * - Retry/backoff по тем же правилам, что и для Anthropic.
 *
 * Финальная ошибка пробрасывается в вызывающий хендлер.
 */
export async function transcribeAudio(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TRANSCRIBER_TIMEOUT_MS);

      const response = await fetch(`${TRANSCRIBER_URL}/transcribe`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const elapsed = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const status = response.status;
        const isRetriable = status === 429 || status >= 500;
        const detail = `HTTP ${status}: ${errorText || response.statusText}`;

        if (!isRetriable || attempt === MAX_ATTEMPTS) {
          log(`GigaAM FAIL: attempt=${attempt}, ${elapsed}ms — ${detail}`);
          throw new Error(`Ошибка транскрибации: ${detail}`);
        }
        const backoffMs = BACKOFF_DELAYS_MS[attempt - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
        log(`GigaAM RETRY: attempt=${attempt} failed (${detail}), ждём ${backoffMs}мс перед попыткой ${attempt + 1}`);
        if (backoffMs > 0) {
          await sleep(backoffMs);
        }
        continue;
      }

      const json = (await response.json()) as { text?: string };
      const text = typeof json.text === 'string' ? json.text.trim() : '';
      log(`GigaAM OK: attempt=${attempt}, ${elapsed}ms, ${text.length}симв.`);
      return text;
    } catch (error) {
      const elapsed = Date.now() - start;
      const isRetriable = error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
      if (!isRetriable || attempt === MAX_ATTEMPTS) {
        if (error instanceof Error && error.message.startsWith('Ошибка транскрибации')) {
          throw error;
        }
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        log(`GigaAM FAIL: attempt=${attempt}, ${elapsed}ms — ${detail}`);
        throw new Error(`Ошибка транскрибации: ${detail}`);
      }
      const backoffMs = BACKOFF_DELAYS_MS[attempt - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      log(`GigaAM RETRY: attempt=${attempt} failed (${detail}), ждём ${backoffMs}мс перед попыткой ${attempt + 1}`);
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }
  }
  throw new Error('Ошибка транскрибации: все попытки исчерпаны');
}
