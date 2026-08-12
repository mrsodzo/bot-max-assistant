import { config, log } from './config.js';

/**
 * Системный промпт ассистента — задаёт роль и стиль общения в групповом чате Max.
 */
export const SYSTEM_PROMPT = `Ты — персональный ассистент в групповом чате мессенджера Max. Твоя задача — помогать участникам чата экономить время и не терять важную информацию в потоке сообщений. Пиши на русском языке, если не указано иное. Форматируй ответы под мессенджер: короткие абзацы, умеренно эмодзи для структуры, без markdown-таблиц и сложной разметки. Не упоминай, что ты языковая модель, если не спрашивают напрямую. Уважай приватность: не сохраняй и не пересказывай личные данные (телефоны, адреса, финансовую информацию), маскируй их как [скрыто]. При неоднозначных или потенциально конфликтных ситуациях в чате — не занимай сторону, оставайся нейтральным.`;

/** Максимальное число попыток внешнего вызова (OpenAI/Whisper). */
const MAX_ATTEMPTS = 3;
/** Базовые задержки backoff для повторных попыток (мс): экспоненциальный рост. */
const BACKOFF_DELAYS_MS = [500, 1000, 2000];

/**
 * Sleep-обёртка для backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Определяет, является ли ошибка повторимой (429 / 5xx / сетевая).
 */
function isRetriableError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('429') || message.includes('too many requests') || message.includes('5xx');
  }
  return false;
}

/**
 * Форматирует ошибку OpenAI-совместимого API в человекочитаемую строку.
 */
function formatOpenAIError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message;
    const match = message.match(/HTTP (\d{3})/);
    if (match) {
      return `HTTP ${match[1]}: ${message.replace(match[0], '').trim() || 'ошибка запроса'}`;
    }
    return `${error.name}: ${message}`;
  }
  return String(error);
}

/**
 * Вызывает OpenAI-совместимый Chat Completions API с retry/backoff.
 */
async function openaiComplete(
  systemPrompt: string,
  userPrompt: string,
  options: { maxTokens?: number } = {},
): Promise<string> {
  const maxTokens = options.maxTokens ?? config.openaiMaxTokens;
  const url = `${config.openaiBaseUrl}/chat/completions`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: config.openaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: config.openaiTemperature,
          max_tokens: maxTokens,
        }),
      });

      const elapsed = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const isRetriable = response.status === 429 || response.status >= 500;
        const detail = `HTTP ${response.status}: ${errorText || response.statusText}`;

        if (!isRetriable || attempt === MAX_ATTEMPTS) {
          log(`OpenAI FAIL: attempt=${attempt}, ${elapsed}ms — ${detail}`);
          throw new Error(`Ошибка OpenAI API: ${detail}`);
        }
        const backoffMs = BACKOFF_DELAYS_MS[attempt - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
        log(`OpenAI RETRY: attempt=${attempt} failed (${detail}), ждём ${backoffMs}мс перед попыткой ${attempt + 1}`);
        if (backoffMs > 0) {
          await sleep(backoffMs);
        }
        continue;
      }

      const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';

      if (!text) {
        log(`OpenAI FAIL: attempt=${attempt}, ${elapsed}ms — пустой ответ`);
        throw new Error('Ошибка OpenAI API: пустой ответ');
      }

      log(`OpenAI OK: model=${config.openaiModel}, attempt=${attempt}, ${elapsed}ms, ${text.length}симв.`);
      return text;
    } catch (error) {
      const elapsed = Date.now() - start;
      if (!isRetriableError(error) || attempt === MAX_ATTEMPTS) {
        const detail = formatOpenAIError(error);
        log(`OpenAI FAIL: attempt=${attempt}, ${elapsed}ms — ${detail}`);
        throw new Error(`Ошибка OpenAI API: ${detail}`);
      }
      const backoffMs = BACKOFF_DELAYS_MS[attempt - 1] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
      const detail = formatOpenAIError(error);
      log(`OpenAI RETRY: attempt=${attempt} failed (${detail}), ждём ${backoffMs}мс перед попыткой ${attempt + 1}`);
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }
  }
  throw new Error('Ошибка OpenAI API: все попытки исчерпаны');
}

/**
 * Краткое резюме (1-2 предложения) расшифровки голосового сообщения.
 * Используется в шаге 3 при обработке голосовых.
 */
export async function summarizeTranscript(transcript: string): Promise<string> {
  const userPrompt = `Сделай краткое резюме этой расшифровки голосового сообщения в 1-2 предложения на русском: ${transcript}`;
  return openaiComplete(SYSTEM_PROMPT, userPrompt, { maxTokens: 256 });
}

/**
 * Перевод произвольного текста на русский язык с автоопределением исходного языка.
 * Если текст уже на русском — возвращает его с пометкой в начале.
 */
export async function translate(text: string): Promise<string> {
  const userPrompt = `Переведи на русский язык, сохранив тон и стиль. Если текст уже на русском — верни его с пометкой в начале. Верни только перевод без пояснений: ${text}`;
  return openaiComplete(SYSTEM_PROMPT, userPrompt, { maxTokens: 1024 });
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
  return openaiComplete(SYSTEM_PROMPT, userPrompt, { maxTokens: 1024 });
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
 * - Retry/backoff по тем же правилам, что и для OpenAI.
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
