import type { Request, Response } from 'express';
import express from 'express';
import type { Update, BotStartedUpdate, MessageCreatedUpdate } from '@maxhub/max-bot-api/types';
import { config, log } from './config.js';
import type { MaxClient } from './maxClient.js';

/**
 * Создаёт Express-приложение для обработки вебхук-запросов от Max.
 *
 * - Проверяет секретный заголовок X-Max-Bot-Api-Secret.
 * - Распознаёт Update из тела запроса.
 * - Обрабатывает update_type === 'bot_started' приветственным сообщением.
 * - Все ошибки внутри обработки ловятся, но бот всегда отвечает 200 OK,
 *   чтобы Max не переотправлял обновления.
 */
export function createApp(maxClient: MaxClient): express.Express {
  const app = express();

  app.use(express.json());

  app.post('/webhook', async (req: Request, res: Response) => {
    try {
      // Проверяем секретный заголовок до любой обработки.
      const secret = req.headers['x-max-bot-api-secret'];
      if (secret !== config.webhookSecret) {
        log('Отклонён вебхук: неверный X-Max-Bot-Api-Secret');
        res.status(401).send('Unauthorized');
        return;
      }

      const update = req.body as Update;
      const updateType = update?.update_type ?? 'unknown';
      const chatId = extractChatId(update);

      log(`Входящий Update: type=${updateType}, chat_id=${chatId ?? 'n/a'}, timestamp=${update?.timestamp ?? 'n/a'}`);

      // Минимальная маршрутизация обновлений.
      if (updateType === 'bot_started') {
        await handleBotStarted(maxClient, update);
      } else {
        // Пока не реализуем обработку остальных типов — просто логируем.
        log(`Пропущен Update типа ${updateType}: обработчик не подключен`);
      }

      // Всегда отвечаем 200 OK, чтобы Max не повторял запрос.
      res.status(200).send();
    } catch (error) {
      log(`Ошибка обработки вебхука: ${formatError(error)}`);
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
 * Обрабатывает событие bot_started: отправляет приветственное сообщение.
 */
async function handleBotStarted(maxClient: MaxClient, update: Update): Promise<void> {
  if (update.update_type !== 'bot_started') {
    return;
  }

  const botStarted = update as BotStartedUpdate;
  const chatId = botStarted.chat_id;

  const greeting =
    'Привет! Я персональный ассистент в этом чате. ' +
    'Пока я умеет: 1) отвечать на твои сообщения, 2) обрабатывать голосовые и аудио, ' +
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
