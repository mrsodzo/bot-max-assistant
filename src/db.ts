import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { log } from './config.js';

/**
 * Типизированный объект сохраняемого сообщения.
 * Поля соответствуют таблице `messages` в SQLite.
 */
export interface SavedMessage {
  chat_id: number;
  message_id: string;
  sender_id?: number | null;
  sender_name?: string | null;
  text: string;
  timestamp: number;
}

/** Строка из БД с дополнительными служебными полями. */
export interface MessageRow extends SavedMessage {
  id: number;
  created_at: number;
}

/**
 * Существующий элемент саммари чата, передаваемый в LLM.
 * Минимально необходимый набор полей для построения саммари.
 */
export interface ChatMessageForSummary {
  sender_name?: string | null;
  text: string;
  timestamp: number;
}

let db: Database.Database | null = null;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  sender_id INTEGER,
  sender_name TEXT,
  text TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_message
  ON messages (chat_id, message_id);
`;

/**
 * Открывает (или создаёт) файл SQLite и прогоняет миграцию.
 * Если DB_PATH содержит подкаталоги — они создаются автоматически.
 *
 * Повторный вызов закрывает предыдущее соединение и открывает новое.
 */
export function initDb(dbPath: string): void {
  try {
    // Создаём родительский каталог, если его нет.
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`Создан каталог базы данных: ${dir}`);
    }

    // Закрываем предыдущее соединение, если оно было открыто.
    if (db) {
      try {
        db.close();
      } catch (closeError) {
        log(`Не удалось закрыть предыдущее соединение БД: ${formatError(closeError)}`);
      }
      db = null;
    }

    db = new Database(dbPath);
    // Включаем WAL для лучшей конкурентности и устойчивости.
    db.pragma('journal_mode = WAL');

    // Прогоняем миграцию (таблица messages + уникальный индекс).
    db.exec(MIGRATION_SQL);

    log(`База данных инициализирована: ${dbPath}`);
  } catch (error) {
    log(`Ошибка инициализации базы данных (${dbPath}): ${formatError(error)}`);
    throw error;
  }
}

/**
 * Сохраняет сообщение в БД.
 * Если text пустой или состоит только из пробелов — не сохраняем (возвращаем false).
 * При дубликате (chat_id, message_id) — INSERT OR IGNORE (возвращаем false).
 */
export function saveMessage(msg: SavedMessage): boolean {
  if (!db) {
    throw new Error('База данных не инициализирована: вызовите initDb() перед saveMessage()');
  }

  // Не сохраняем пустые/пробельные сообщения.
  if (!msg.text || msg.text.trim().length === 0) {
    return false;
  }

  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO messages
         (chat_id, message_id, sender_id, sender_name, text, timestamp, created_at)
       VALUES (@chat_id, @message_id, @sender_id, @sender_name, @text, @timestamp, @created_at)`,
    );

    const result = stmt.run({
      chat_id: msg.chat_id,
      message_id: msg.message_id,
      sender_id: msg.sender_id ?? null,
      sender_name: msg.sender_name ?? null,
      text: msg.text,
      timestamp: msg.timestamp,
      created_at: Date.now(),
    });

    return result.changes > 0;
  } catch (error) {
    log(`Ошибка сохранения сообщения (chat_id=${msg.chat_id}, message_id=${msg.message_id}): ${formatError(error)}`);
    throw error;
  }
}

/**
 * Возвращает последние `count` сообщений чата (по timestamp DESC),
 * но в порядке возрастания времени — удобно для саммари.
 */
export function getMessagesByCount(chat_id: number, count: number): MessageRow[] {
  if (!db) {
    throw new Error('База данных не инициализирована: вызовите initDb() перед getMessagesByCount()');
  }

  try {
    const stmt = db.prepare(
      `SELECT * FROM messages
       WHERE chat_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    );
    const rows = stmt.all(chat_id, count) as MessageRow[];
    // Переворачиваем в возрастание времени.
    return rows.reverse();
  } catch (error) {
    log(`Ошибка getMessagesByCount(chat_id=${chat_id}, count=${count}): ${formatError(error)}`);
    throw error;
  }
}

/**
 * Возвращает все сообщения чата с timestamp >= sinceMs, по возрастанию времени.
 */
export function getMessagesByPeriod(chat_id: number, sinceMs: number): MessageRow[] {
  if (!db) {
    throw new Error('База данных не инициализирована: вызовите initDb() перед getMessagesByPeriod()');
  }

  try {
    const stmt = db.prepare(
      `SELECT * FROM messages
       WHERE chat_id = ? AND timestamp >= ?
       ORDER BY timestamp ASC`,
    );
    return stmt.all(chat_id, sinceMs) as MessageRow[];
  } catch (error) {
    log(`Ошибка getMessagesByPeriod(chat_id=${chat_id}, sinceMs=${sinceMs}): ${formatError(error)}`);
    throw error;
  }
}

/**
 * Закрывает соединение с БД (вызывать при graceful shutdown).
 */
export function closeDb(): void {
  if (!db) {
    return;
  }
  try {
    db.close();
    log('Соединение с базой данных закрыто');
  } catch (error) {
    log(`Ошибка при закрытии базы данных: ${formatError(error)}`);
  } finally {
    db = null;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
