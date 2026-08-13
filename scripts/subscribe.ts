import { config, log } from '../src/config.js';
import { createMaxClient } from '../src/maxClient.js';
import { loadExtraCaCert } from '../src/ca.js';
import type { UpdateType } from '@maxhub/max-bot-api/types';

loadExtraCaCert();

/**
 * Скрипт подписки вебхука.
 *
 * Запуск: npm run subscribe
 * Подписывает URL из env на события message_created и bot_started.
 */
async function main(): Promise<void> {
  const maxClient = createMaxClient();

  try {
    const updateTypes: UpdateType[] = ['message_created', 'bot_started'];
    const result = await maxClient.subscribeWebhook(
      config.webhookUrl,
      updateTypes,
      config.webhookSecret,
    );
    log(`Результат подписки: ${JSON.stringify(result)}`);
  } catch (error) {
    log(`Подписка не удалась: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
