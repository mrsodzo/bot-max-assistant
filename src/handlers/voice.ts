import type { Message } from '@maxhub/max-bot-api/types';
import { parseBuffer } from 'music-metadata';
import { transcribeAudio, summarizeTranscript } from '../llm.js';
import { createMaxClient } from '../maxClient.js';
import { log } from '../config.js';

type AudioAttachmentLike = {
  type: 'audio';
  payload: {
    url: string;
    token: string;
  };
};

const DOWNLOAD_TIMEOUT_MS = 60_000;
const SUMMARY_THRESHOLD_SECONDS = 30;
const MAX_RESPONSE_LENGTH = 4000;
const TRANSCRIPT_TRUNCATE_LENGTH = 3500;
const SUMMARY_TRUNCATE_LENGTH = 3900;

export async function handleVoiceMessage(message: Message): Promise<void> {
  const chatId = message.recipient.chat_id;
  if (chatId == null) {
    log('handleVoiceMessage: chat_id отсутствует в сообщении');
    return;
  }

  const audioAttachment = message.body.attachments?.find(
    (a): a is AudioAttachmentLike => a.type === 'audio',
  );

  if (!audioAttachment) {
    return;
  }

  const maxClient = createMaxClient();

  let buffer: Buffer;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    const response = await fetch(audioAttachment.payload.url, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (error) {
    log(`Ошибка скачивания голосового сообщения: ${formatError(error)}`);
    await maxClient.sendMessage(chatId, 'Не удалось получить голосовое сообщение', { format: 'markdown' });
    return;
  }

  let durationSeconds: number | null = null;
  try {
    const metadata = await parseBuffer(new Uint8Array(buffer));
    durationSeconds = metadata.format.duration ?? null;
    log(`Определена длительность аудио: ${durationSeconds ?? 'не определена'}с`);
  } catch (error) {
    log(`Не удалось определить длительность аудио: ${formatError(error)}. Переходим к консервативному режиму (длинное).`);
    durationSeconds = null;
  }

  let transcript: string;
  try {
    const filename = extractFilename(audioAttachment.payload.url) ?? 'audio.mp3';
    const mimeType = detectMimeType(audioAttachment.payload.url) ?? 'audio/mpeg';
    log(`Начинаем транскрибацию: filename=${filename}, mimeType=${mimeType}, размер=${buffer.length}байт`);
    transcript = await transcribeAudio(buffer, filename, mimeType);
    log(`Транскрибация завершена: ${transcript.length} символов`);
  } catch (error) {
    log(`Ошибка транскрибации: ${formatError(error)}`);
    await maxClient.sendMessage(chatId, 'Не удалось распознать речь', { format: 'markdown' });
    return;
  }

  if (!transcript || transcript.trim().length === 0) {
    log('Транскрипция пустая');
    await maxClient.sendMessage(chatId, 'Не удалось распознать речь', { format: 'markdown' });
    return;
  }

  const needsSummary = durationSeconds == null || durationSeconds > SUMMARY_THRESHOLD_SECONDS;

  let summary: string | null = null;
  if (needsSummary) {
    try {
      summary = await summarizeTranscript(transcript);
      log(`Саммари готово: ${summary.length} символов`);
    } catch (error) {
      log(`Ошибка генерации саммари: ${formatError(error)}`);
      summary = null;
    }
  }

  const finalTranscript =
    transcript.length > TRANSCRIPT_TRUNCATE_LENGTH
      ? transcript.slice(0, TRANSCRIPT_TRUNCATE_LENGTH - 1).trimEnd() + '…'
      : transcript;

  if (finalTranscript.length < transcript.length) {
    log(`Расшифровка обрезана до ${TRANSCRIPT_TRUNCATE_LENGTH} символов`);
  }

  let responseText = `📝 Расшифровка: ${finalTranscript}`;

  if (summary !== null) {
    const finalSummary =
      summary.length > SUMMARY_TRUNCATE_LENGTH
        ? summary.slice(0, SUMMARY_TRUNCATE_LENGTH - 1).trimEnd() + '…'
        : summary;

    if (finalSummary.length < summary.length) {
      log(`Саммари обрезано до ${SUMMARY_TRUNCATE_LENGTH} символов`);
    }

    responseText += `\n\n💡 Кратко: ${finalSummary}`;
  }

  if (responseText.length > MAX_RESPONSE_LENGTH) {
    responseText = responseText.slice(0, MAX_RESPONSE_LENGTH - 1).trimEnd() + '…';
    log(`Ответ обрезан до ${MAX_RESPONSE_LENGTH} символов`);
  }

  try {
    await maxClient.sendMessage(chatId, responseText, { format: 'markdown' });
  } catch (error) {
    log(`Ошибка отправки ответа в chat_id=${chatId}: ${formatError(error)}`);
  }
}

function extractFilename(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const basename = pathname.split('/').pop() ?? '';
    if (basename.includes('.') && basename.length > 1) {
      return basename;
    }
    return null;
  } catch {
    return null;
  }
}

function detectMimeType(url: string): string | null {
  const pathname = new URL(url).pathname.toLowerCase();
  const extension = pathname.split('.').pop() ?? '';
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    wma: 'audio/x-ms-wma',
    opus: 'audio/opus',
  };
  return map[extension] ?? null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
