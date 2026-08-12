import type { Message } from '@maxhub/max-bot-api/types';
import { translate } from '../llm.js';
import { createMaxClient } from '../maxClient.js';
import { log } from '../config.js';

const MAX_RESPONSE_LENGTH = 4000;
const TRUNCATE_SUFFIX_LENGTH = 3900;

export async function handleTranslate(message: Message): Promise<boolean> {
  const linkType = message.link?.type ?? 'none';
  const trigger = (message.body.text ?? '').trim().toLowerCase();
  log(`[DBG] handleTranslate: linkType=${linkType} trigger="${trigger}"`);

  if (message.link?.type !== 'reply') {
    return false;
  }

  const isTranslateTrigger = trigger === 'переведи' || trigger.startsWith('/translate');
  log(`[DBG] handleTranslate: isTranslateTrigger=${isTranslateTrigger}`);
  if (!isTranslateTrigger) {
    return false;
  }

  const chatId = message.recipient.chat_id;
  if (chatId == null) {
    log('handleTranslate: chat_id отсутствует в сообщении');
    return true;
  }

  const link = message.link;
  type LinkedMessageLike = { type: string; message?: { text?: string } };
  const linked = link as LinkedMessageLike | null | undefined;
  log(`[DBG] handleTranslate: link=${JSON.stringify(linked)}`);
  const source = linked?.message?.text?.trim();
  if (!source) {
    log(`[DBG] handleTranslate: source is empty, sending fallback message`);
    await createMaxClient().sendMessage(chatId, 'Нет текста для перевода');
    return true;
  }
  log(`[DBG] handleTranslate: source="${source.slice(0, 100)}"`);

  let translation: string;
  try {
    translation = await translate(source);
  } catch (error) {
    log(`Ошибка перевода: ${formatError(error)}`);
    await createMaxClient().sendMessage(chatId, 'Не удалось перевести сообщение');
    return true;
  }

  if (translation.length > MAX_RESPONSE_LENGTH) {
    translation = translation.slice(0, TRUNCATE_SUFFIX_LENGTH - 1).trimEnd() + '…';
    log(`Перевод обрезан до ${TRUNCATE_SUFFIX_LENGTH} символов`);
  }

  if (translation !== source && (translation.startsWith('[уже на русском]') || translation.includes('уже на русском'))) {
    log('Текст уже на русском');
  }

  try {
    await createMaxClient().sendMessage(chatId, translation);
  } catch (error) {
    log(`Ошибка отправки перевода в chat_id=${chatId}: ${formatError(error)}`);
  }

  return true;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
