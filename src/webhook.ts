import type { Request, Response } from 'express';
import express from 'express';
import type { Update, MessageCreatedUpdate, BotStartedUpdate } from '@maxhub/max-bot-api/types';
import { config, log } from './config.js';
import type { MaxClient } from './maxClient.js';
import { handleTranslate } from './handlers/translate.js';
import { handleSummary } from './handlers/summary.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { saveMessage } from './db.js';

/**
 * Создаёт Express-приложение для обработки вебхук-запросов от Max.
 *
 * - Проверяет секретный заголовок X-Max-Bot-Api-Secret.
 * - Распознаёт Update из тела запроса.
 * - Роутит message_created по хендлерам (translate → summary → voice → save).
 * - Все ошибки внутри обработки ловятся, но бот всегда отвечает 200 OK,
 *   чтобы Max не переотправлял обновления.
 */
export function createApp(maxClient: MaxClient): express.Express {
  const app = express();

  app.use(express.json());

  app.post('/', async (req: Request, res: Response) => {
    try {
      const secret = req.headers['x-max-bot-api-secret'];
      if (secret !== config.webhookSecret) {
        log('Отклонён вебхук: неверный X-Max-Bot-Api-Secret');
        res.status(401).send('Unauthorized');
        return;
      }

      const update = req.body as Update;
      const updateType = update?.update_type ?? 'unknown';

      log(`[IN] ${updateType} chat=${extractChatId(update) ?? 'n/a'} ts=${update?.timestamp ?? 'n/a'}`);

      if (updateType === 'message_created') {
        const message = (update as MessageCreatedUpdate).message;
        if (!message) {
          log('[ERR] message_created: отсутствует message в обновлении');
          res.status(200).send();
          return;
        }

        const chatId = message.recipient.chat_id;
        const body = message.body;
        const text = (body?.text ?? '').trim();
        const hasAudio = body?.attachments?.some((a) => a.type === 'audio');
        const linkType = message.link?.type ?? 'none';
        const replyMid = (message.link as any)?.message?.body?.mid ?? 'none';

        log(`[DBG] message: text="${text}" linkType=${linkType} replyMid=${replyMid}`);

        if (text.toLowerCase() === '/start') {
          await handleBotStarted(maxClient, update);
          res.status(200).send();
          return;
        }

        if (await handleTranslate(message)) {
          log('[DBG] handled by translate');
          res.status(200).send();
          return;
        }

        if (await handleSummary(message)) {
          log('[DBG] handled by summary');
          res.status(200).send();
          return;
        }

        if (hasAudio) {
          log('[DBG] handled by voice');
          await handleVoiceMessage(message);
          res.status(200).send();
          return;
        }

        log('[DBG] no handler matched, saving to DB');

        if (text.length > 0 && chatId != null) {
          const sender = message.sender;
          const senderId = typeof sender?.user_id === 'number' ? sender.user_id : null;
          const senderName = typeof sender?.name === 'string' ? sender.name : null;
          saveMessage({
            chat_id: chatId,
            message_id: body!.mid,
            sender_id: senderId,
            sender_name: senderName,
            text: text,
            timestamp: message.timestamp ?? Date.now(),
          });
        }

        res.status(200).send();
        return;
      }

      if (updateType === 'bot_started') {
        await handleBotStarted(maxClient, update);
      } else {
        log(`[IN] Пропущен Update типа ${updateType}: обработчик не подключен`);
      }

      res.status(200).send();
    } catch (error) {
      log(`[ERR] ${req.body?.update_type ?? 'unknown'} ${formatError(error)}`);
      res.status(200).send();
    }
  });

  return app;
}

/**
 * Извлекает chat_id из Update, если это возможно.
 * - Для bot_started и других чатовых обновлений: поле chat_id.
 * - Для message_created: message.recipient.chat_id.
 */
function extractChatId(update: Update): number | undefined {
  if (!update) {
    return undefined;
  }

  if ('chat_id' in update && typeof update.chat_id === 'number') {
    return update.chat_id;
  }

  if (update.update_type === 'message_created') {
    const messageUpdate = update as MessageCreatedUpdate;
    const chatId = messageUpdate.message?.recipient?.chat_id;
    if (typeof chatId === 'number') {
      return chatId;
    }
  }

  return undefined;
}

/**
 * Обрабатывает событие bot_started или /start в message_created: отправляет приветственное сообщение.
 */
async function handleBotStarted(maxClient: MaxClient, update: Update): Promise<void> {
  let chatId: number | null | undefined;

  if (update.update_type === 'bot_started') {
    const botStarted = update as BotStartedUpdate;
    chatId = botStarted.chat_id;
  } else if (update.update_type === 'message_created') {
    const messageUpdate = update as MessageCreatedUpdate;
    const body = messageUpdate.message?.body;
    const text = (body?.text ?? '').trim();
    if (text.toLowerCase() === '/start') {
      chatId = messageUpdate.message?.recipient?.chat_id;
    }
  }

  if (chatId == null) {
    return;
  }

  const greeting =
    'Привет! Я персональный ассистент в этом чате. ' +
    'Пока я умею: 1) отвечать на твои сообщения, 2) обрабатывать голосовые и аудио, ' +
    '3) помогать с заметками и напоминаниями. Просто напиши мне!';

  try {
    await maxClient.sendMessage(chatId, greeting);
  } catch (error) {
    log(`Не удалось отправить приветствие: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
