# Промт для ИИ-агента — Шаг 2: SQLite + LLM/STT-обёртки

> Это **второй из 6 шагов**. Предполагается, что **Шаг 1 уже выполнен**: в репозитории есть `package.json`, `tsconfig.json`, `src/config.ts`, `src/maxClient.ts`, `src/webhook.ts`, `src/rateLimiter.ts`, `src/index.ts`, `.env.example`. Если чего-то нет — сначала проверь и создавай только то, что относится к этому шагу.

## Общие требования (обязательно прочти перед началом)
1. Проект: `C:\Work\Projects\bot-max-assistant\` (Windows PowerShell). TypeScript **strict**. Используем `@anthropic-ai/sdk`, `better-sqlite3`, `music-metadata` (уже в `package.json` из шага 1).
2. **Не выдумывай** поля/методы API — только то, что описано ниже и в реальных типах библиотек.
3. Комментарии на русском в ключевых местах логики.
4. Обработка ошибок на каждом внешнем вызове (Anthropic, Whisper) — `try/catch`, логирование, retry/backoff. Не throw наверх без обёртки, если можно вернуть понятную ошибку.
5. Логирование: `console.log` с ISO-timestamp (`new Date().toISOString()`).
6. При завершении: запусти `npx tsc --noEmit` и убедись, что TS-ошибок нет; если есть — исправь.
7. **НЕ создавай** новые промт-файлы и **НЕ редактируй** `bot-max-assistant.md`, `logo.jpg`, другие промт-файлы, `.kilo/`. Не трогай файлы шага 1, кроме минимальных правок импортов если строго необходимо (лучше дополнять, не ломая).
8. В конце сообщи: какие файлы создал/изменил и команду проверки (`npx tsc --noEmit`).

## Системный промпт LLM (вложи как константу в `src/llm.ts`)
> Ты — персональный ассистент в групповом чате мессенджера Max. Твоя задача — помогать участникам чата экономить время и не терять важную информацию в потоке сообщений. Пиши на русском языке, если не указано иное. Форматируй ответы под мессенджер: короткие абзацы, умеренно эмодзи для структуры, без markdown-таблиц и сложной разметки. Не упоминай, что ты языковая модель, если не спрашивают напрямую. Уважай приватность: не сохраняй и не пересказывай личные данные (телефоны, адреса, финансовую информацию), маскируй их как [скрыто]. При неоднозначных или потенциально конфликтных ситуациях в чате — не занимай сторону, оставайся нейтральным.

## Что нужно создать в этом шаге

### 1. `src/db.ts` — работа с SQLite через `better-sqlite3`
- Типизированный объект БД. При инициализации:
  - если файла БД нет — создаётся и прогоняется миграция (таблица `messages`).
  - каталог БД создаётся автоматически, если `DB_PATH` содержит подкаталог.
- Схема таблицы `messages`:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `chat_id INTEGER NOT NULL`
  - `message_id TEXT NOT NULL` — `message.body.mid`
  - `sender_id INTEGER` — `message.sender?.user_id` (может быть null для каналов)
  - `sender_name TEXT` — `message.sender?.name` (или `sender?.username`)
  - `text TEXT NOT NULL`
  - `timestamp INTEGER NOT NULL` — `message.timestamp` (ms)
  - `created_at INTEGER NOT NULL` — `Date.now()` на момент записи
  - Уникальный индекс по `(chat_id, message_id)` чтобы не дублировать.
- Функции:
  - `initDb(dbPath: string)` → открыть/создать БД, миграция, экспорт через модуль.
  - `saveMessage(msg: { chat_id, message_id, sender_id?, sender_name?, text, timestamp })` — игнор если `text` пустой/только пробелы (не сохраняем). Если дубликат по `(chat_id, message_id)` — `INSERT OR IGNORE` или проверка.
  - `getMessagesByCount(chat_id, count)` — последние `count` сообщений по `timestamp DESC` (верни в порядке возрастания времени для саммари).
  - `getMessagesByPeriod(chat_id, sinceMs)` — все сообщения с `timestamp >= sinceMs`, по возрастанию.
  - `closeDb()`.
- Все вызовы БД синхронны (`better-sqlite3`). Обёрнуты в `try/catch` с логированием, но Sangkok/синхронная throw приемлема — её ловит вызывающий хендлер (шаги 3-5).

### 2. `src/llm.ts` — обёртки над Anthropic и Whisper
- Импорт `@anthropic-ai/sdk`. Создаёт `Anthropic` клиент из `config.anthropicApiKey`. Если ключа нет — throw с понятным сообщением при первом вызове (lazy init).
- **Системный промпт** — как константа `SYSTEM_PROMPT` (текст выше).
- `async summarizeTranscript(transcript: string): Promise<string>` — бережётс **краткое резюме в 1-2 предложения** для расшифровки голосового (используется в шаге 3). Системный промпт + user-промпт «Сделай краткое резюме этой расшифровки голосового сообщения в 1-2 предложения на русском: …».
- `async translate(text: string): Promise<string>` — перевод на русский с автоопределением исходного языка. User-промпт: «Переведи на русский язык, сохранив тон и стиль. Если текст уже на русском — верни его с пометкой в начале. Верни только перевод без пояснений: …». Системный промпт общий.
- `async summarizeChat(messages: {sender_name?: string, text: string, timestamp: number}[]): Promise<string>` — структурированное саммари по темам с выделением блока явных договорённостей. User-промпт: «Сделай структурированное саммари обсуждения ниже по темам. В конце отдельным блоком выдели явные договорённости/решения. Сообщения: …». Системный промпт общий.
- Все вызовы Anthropic через общую внутреннюю функцию `anthropicComplete(systemPrompt, userPrompt, options)` с retry/backoff.
- **Whisper** (транскрибация): `async transcribeAudio(buffer: Buffer, filename: string, mimeType: string): Promise<string>`.
  - REST к `https://api.openai.com/v1/audio/transcriptions`.
  - `Authorization: Bearer {OPENAI_API_KEY}`, `multipart/form-data` с полями `file` (Blob/buffer с filename + mimeType), `model: 'whisper-1'`, `language: 'ru'` (или `language`.Optional — проверь supports; если не уверен — НЕ передавай `language`).
  - Парс `response.json().text`.
- **Retry/backoff** для Anthropic и Whisper: при 429/5xx — до **3 попыток** с экспоненциальным backoff (500ms, 1000ms, 2000ms). При 4xx (кроме 429) — не повторять, throw с понятным сообщением. Финальный throw ловится в хендлерах (шаги 3-5).
- Логирование: длительность каждого внешнего вызова, успех/ошибка.

### 3. Минимальные правки шага 1, если нужны
- В `src/index.ts` — проинициализировать БД при старте (`initDb(config.dbPath)`) и закрыть при `SIGINT`/`SIGTERM`.
- НЕ ломай webhook/роутинг — хендлеры добавятся в шагах 3-6.

## Edge-cases (реализуй)
- (а) SQLite файл не существует → создать каталог, файл и прогнать миграцию при старте (`initDb`).
- (б) Anthropic/Whisper 429/5xx → retry до 3 попыток с backoff, затем throw → ловится в хендлерах шагов 3-5.
- (в) пустой `text` сообщения — не сохраняем в БД (`saveMessage` возвращает `false` или 0).
- (г) `ANTHROPIC_API_KEY` или `OPENAI_API_KEY` отсутствует — throw с понятным сообщением при первом вызове (lazy), а не при старте всего приложения, чтобы бот продолжал обрабатывать другие сценарии.

## Критерии готовности
- `npx tsc --noEmit` без ошибок.
- Файлы созданы/обновлены: `src/db.ts`, `src/llm.ts`, правки в `src/index.ts`.
- БД инициализируется при старте; функции экспортируются и типизированы.

## Если экспорты библиотек отличаются
- `@anthropic-ai/sdk`: последняя версия использует `Anthropic` (дефолтный экспорт) и `client.messages.create({ model, max_tokens, system, messages: [{role:'user', content}] })`. Проверь версию в `package.json` после `npm install` и адаптируй. Модель по умолчанию — `claude-3-5-sonnet-latest` или ближайшая доступная; если не уверен — используй `claude-3-5-sonnet-20241022` и выноси в `config.llmModel` в `src/config.ts` (добавь поле с дефолтом).
- `better-sqlite3`: дефолтный импорт `import Database from 'better-sqlite3'`, `const db = new Database(path)`.
- Whisper: нативный `fetch` (Node 18+). Не выдумывай SDK.
