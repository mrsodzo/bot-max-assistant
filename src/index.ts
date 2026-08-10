import { config, log } from './config.js';
import { createMaxClient } from './maxClient.js';
import { createApp } from './webhook.js';
import { initDb, closeDb } from './db.js';

/**
 * Точка входа в приложение.
 *
 * Создаёт клиент Max, инициализирует SQLite, запускает Express-сервер
 * и слушает вебхуки. При SIGINT/SIGTERM корректно завершает работу.
 */
const maxClient = createMaxClient();
initDb(config.dbPath); // создаём/открываем базу и прогоняем миграцию
const app = createApp(maxClient);

const server = app.listen(config.port, () => {
  log(`Listening on port ${config.port}`);
});

function gracefulShutdown(signal: string): void {
  log(`Получен сигнал ${signal}, завершаю работу...`);
  server.close((error) => {
    if (error) {
      log(`Ошибка при закрытии сервера: ${error.message}`);
    } else {
      log('Сервер остановлен');
    }
    // Закрываем соединение с БД даже при ошибке закрытия сервера.
    closeDb();
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
