import { Bot } from '@maxhub/max-bot-api';
import type { Message, UpdateType } from '@maxhub/max-bot-api/types';
import { config, log } from './config.js';
import { createRateLimiter, type RateLimiter } from './rateLimiter.js';

/**
 * Тонкая обёртка над официальным SDK Max Bot API.
 *
 * Отвечает за:
 * - создание инстанса Bot;
 * - отправку сообщений с учётом rate limiter;
 * - подписку вебхука (через fetch, т.к. это административный вызов;
 *   в SDK subgroup subscriptions есть только getUpdates/long-polling, без POST /subscriptions);
 * - предоставление доступа к инстансу Bot для расширенных сценариев.
 */
export type SendMessageExtra = Parameters<Bot['api']['sendMessageToChat']>[2];

export interface MaxClient {
  sendMessage(chatId: number, text: string, extra?: SendMessageExtra): Promise<Message>;
  subscribeWebhook(url: string, updateTypes: UpdateType[], secret: string): Promise<unknown>;
  getBot(): Bot;
}

const API_BASE = 'https://platform-api2.max.ru';

export function createMaxClient(): MaxClient {
  const bot = new Bot(config.botToken);
  const rateLimiter: RateLimiter = createRateLimiter();

  return {
    /**
     * Отправляет сообщение в указанный чат, пропуская вызов через rate limiter.
     * Логирует исходящее сообщение (chat_id и длину текста).
     */
    async sendMessage(chatId: number, text: string, extra?: SendMessageExtra): Promise<Message> {
      log(`Исходящее сообщение: chat_id=${chatId}, длина текста=${text.length}`);
      try {
        return await rateLimiter.sendToChat(chatId, () => bot.api.sendMessageToChat(chatId, text, extra));
      } catch (error) {
        log(`Ошибка при отправке сообщения в chat_id=${chatId}: ${formatError(error)}`);
        throw error;
      }
    },

    /**
     * Подписывает вебхук на указанный URL и типы обновлений.
     * В SDK subgroup subscriptions есть только long-polling getUpdates,
     * поэтому подписку реализуем через нативный fetch к POST /subscriptions.
     */
    async subscribeWebhook(url: string, updateTypes: UpdateType[], secret: string): Promise<unknown> {
      const endpoint = `${API_BASE}/subscriptions`;
      const body = {
        url,
        update_types: updateTypes,
        secret,
      };

      log(`Подписка вебхука: url=${url}, update_types=${updateTypes.join(',')}`);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: config.botToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = (await response.json()) as unknown;
        log(`Подписка вебхука выполнена успешно: ${JSON.stringify(result)}`);
        return result;
      } catch (error) {
        log(`Ошибка при подписке вебхука: ${formatError(error)}`);
        throw error;
      }
    },

    /**
     * Возвращает инстанс Bot SDK (используется на шаге 6).
     */
    getBot(): Bot {
      return bot;
    },
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
