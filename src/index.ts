import { config, log } from './config.js';
import { createMaxClient } from './maxClient.js';
import { createApp } from './webhook.js';

/**
 * Точка входа в приложение.
 *
 * Создаёт клиент Max, запускает Express-сервер и слушает вебхуки.
 * При SIGINT/SIGTERM корректно завершает работу.
 */
const maxClient = createMaxClient();
const app = createApp(maxClient);

const server = app.listen(config.port, () => {
  log(`Listening on port ${config.port}`);
});

function gracefulShutdown(signal: string): void {
  log(`Получен сигнал ${signal}, завершаю работу...`);
  server.close((error) => {
    if (error) {
      log(`Ошибка при закрытии сервера: ${error.message}`);
      process.exit(1);
    }
    log('Сервер остановлен');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
