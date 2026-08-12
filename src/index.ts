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
initDb(config.dbPath);

try {
  await maxClient.getBot().api.setMyCommands([
    { name: 'start', description: 'Запустить бота / приветствие' },
    { name: 'translate', description: 'Перевести сообщение, на которое сделан reply (или просто reply с «переведи»)' },
    { name: 'summary', description: 'Саммари обсуждения: /summary, /summary 50, /summary 24h' },
  ]);
  log('Команды бота зарегистрированы');
} catch (error) {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const cause = error instanceof Error && error.cause ? ` | cause: ${error.cause}` : '';
  log(`Ошибка регистрации команд бота: ${msg}${cause}`);
}

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
