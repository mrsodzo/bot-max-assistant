import type { Message } from '@maxhub/max-bot-api/types';
import { summarizeChat } from '../llm.js';
import { getMessagesByCount, getMessagesByPeriod, type MessageRow } from '../db.js';
import { createMaxClient } from '../maxClient.js';
import { log } from '../config.js';

const MAX_RESPONSE_LENGTH = 4000;

export async function handleSummary(message: Message): Promise<boolean> {
  const t = (message.body.text ?? '').trim().toLowerCase();
  if (t !== '/summary' && !t.startsWith('/summary ')) {
    return false;
  }

  const chatId = message.recipient.chat_id;
  if (chatId == null) {
    log('handleSummary: chat_id отсутствует в сообщении');
    return true;
  }

  const arg = t.slice('/summary'.length).trim();
  const parsed = parseArg(arg);

  let messages: MessageRow[];
  try {
    if (parsed.mode === 'count') {
      messages = getMessagesByCount(chatId, parsed.count);
    } else {
      messages = getMessagesByPeriod(chatId, parsed.sinceMs);
    }
  } catch (error) {
    log(`Ошибка получения сообщений из БД: ${formatError(error)}`);
    await createMaxClient().sendMessage(chatId, 'Не удалось получить историю сообщений', { format: 'markdown' });
    return true;
  }

  log(`/summary: получено ${messages.length} сообщений`);

  if (messages.length < 5) {
    await createMaxClient().sendMessage(chatId, 'Слишком мало сообщений для саммари', { format: 'markdown' });
    return true;
  }

  const chatMessages = messages.map((m) => ({
    sender_name: m.sender_name || `участник ${m.sender_id}`,
    text: m.text,
    timestamp: m.timestamp,
  }));

  let summary: string;
  try {
    summary = await summarizeChat(chatMessages);
  } catch (error) {
    log(`Ошибка генерации саммари: ${formatError(error)}`);
    await createMaxClient().sendMessage(chatId, 'Не удалось составить саммари', { format: 'markdown' });
    return true;
  }

  summary = summary.trim();
  if (!summary || summary.length === 0) {
    log('/summary: LLM вернул пустой результат');
    await createMaxClient().sendMessage(chatId, 'Не удалось составить саммари', { format: 'markdown' });
    return true;
  }

  const parts = splitForMax(summary, MAX_RESPONSE_LENGTH);
  log(`/summary: саммари разбито на ${parts.length} частей`);

  const maxClient = createMaxClient();
  for (const part of parts) {
    try {
      await maxClient.sendMessage(chatId, part, { format: 'markdown' });
    } catch (error) {
      log(`Ошибка отправки саммари: ${formatError(error)}`);
      await maxClient.sendMessage(chatId, 'Не удалось отправить саммари', { format: 'markdown' });
      break;
    }
  }

  return true;
}

function parseArg(arg: string): { mode: 'count'; count: number } | { mode: 'period'; sinceMs: number } {
  if (!arg) {
    return { mode: 'count', count: 50 };
  }

  const numMatch = arg.match(/^(\d+)$/);
  if (numMatch) {
    let n = parseInt(numMatch[1], 10);
    if (n < 1) {
      n = 1;
      log(`/summary: N=${numMatch[1]} < 1, clamp до 1`);
    } else if (n > 500) {
      n = 500;
      log(`/summary: N=${numMatch[1]} > 500, clamp до 500`);
    }
    return { mode: 'count', count: n };
  }

  const periodMatch = arg.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (periodMatch && (periodMatch[1] || periodMatch[2] || periodMatch[3])) {
    const days = periodMatch[1] ? parseInt(periodMatch[1], 10) : 0;
    const hours = periodMatch[2] ? parseInt(periodMatch[2], 10) : 0;
    const minutes = periodMatch[3] ? parseInt(periodMatch[3], 10) : 0;
    const totalMs = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;

    if (totalMs < 60_000) {
      log('/summary: период <1m, clamp до 1m');
      return { mode: 'period', sinceMs: Date.now() - 60_000 };
    }
    if (totalMs > 7 * 24 * 60 * 60 * 1000) {
      log('/summary: период >7d, clamp до 7d');
      return { mode: 'period', sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000 };
    }

    return { mode: 'period', sinceMs: Date.now() - totalMs };
  }

  log(`/summary: нераспознанный аргумент "${arg}", взял дефолт 50 сообщений`);
  return { mode: 'count', count: 50 };
}

function splitForMax(text: string, limit = 4000): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current);
        current = '';
      }
      if (paragraph.length > limit) {
        const subChunks = splitLongText(paragraph, limit);
        chunks.push(...subChunks);
      } else {
        current = paragraph;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [text.slice(0, limit - 1).trimEnd() + '…'];
}

function splitLongText(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current);
        current = '';
      }
      if (line.length > limit) {
        const subChunks = splitBySentences(line, limit);
        chunks.push(...subChunks);
      } else {
        current = line;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitBySentences(text: string, limit: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length <= limit) {
      current += sentence;
    } else {
      if (current) {
        chunks.push(current);
        current = '';
      }
      if (sentence.length > limit) {
        for (let i = 0; i < sentence.length; i += limit) {
          const slice = sentence.slice(i, i + limit);
          chunks.push(slice.trimEnd() + (i + limit < sentence.length ? '…' : ''));
        }
      } else {
        current = sentence;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
