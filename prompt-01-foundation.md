# Промт для ИИ-агента — Шаг 1: Фундамент проекта (Max Bot webhook)

> Это **первый из 6 шагов** пошагового создания бота-ассистента для мессенджера Max. Выполни только этот шаг. Остальные шаги будут запускаться отдельными промтами позже.

## Общие требования (обязательно прочти перед началом)
1. Проект: `C:\Work\Projects\bot-max-assistant\` (Windows PowerShell). Node.js + TypeScript **strict mode**. Используем официальный SDK `@maxhub/max-bot-api` (npm).
2. **Не выдумывай поля объектов Max** — используй ТОЛЬКО факты из блока «Схема объектов Max» ниже.
3. Комментарии на русском в ключевых местах логики.
4. Обработка ошибок на каждом внешнем вызове (Max API) — `try/catch`, логирование, бот продолжает работать. Не throw наверх без оборачивания.
5. Логирование: `console.log` с ISO-timestamp (`new Date().toISOString()`) для входящих Update и исходящих ответов.
6. При завершении: запусти `npx tsc --noEmit` и убедись, что TS-ошибок нет; если есть — исправь.
7. **НЕ создавай** новые промт-файлы (`prompt-*.md`) и **НЕ редактируй** `bot-max-assistant.md`, `logo.jpg`, этот промт и другие промт-файлы. Не трогай `.kilo/`.
8. В конце сообщения сообщи: какие файлы создал/изменил и какой командой проверить (`npx tsc --noEmit`).

## Схема объектов Max (источник: dev.max.ru/docs-api + исходники SDK @maxhub/max-bot-api)
- Домен API: `platform-api2.max.ru`. Авторизация: заголовок `Authorization: <token>`.
- SDK: `import { Bot } from '@maxhub/max-bot-api'; const bot = new Bot(process.env.BOT_TOKEN)`.
  - Webhook извне: Express слушает `/webhook`, тело запроса — объект `Update`. С SDK работаем через типы `Update`, `Message`, `MessageCreatedUpdate` из `@maxhub/max-bot-api` (или через `bot.handleUpdate(update)` если доступен такой метод — проверь экспорты SDK).
- **Update** (`message_created`): `{ update_type: string, timestamp: number, message: Message, user_locale?: string }`.
- **Update** (`bot_started`): `{ update_type: 'bot_started', timestamp: number, chat_id: number, user: User }`.
- **Message**: `{ sender?: User, recipient: { chat_id: number, chat_type: string }, timestamp: number, link?: LinkedMessage | null, body: { mid: string, seq: number, text: string | null, attachments: Attachment[] | null } }`.
- **Webhook требования**: HTTPS на порту 443 на стороне MAX; локально Express слушает `PORT` (из env, по умолчанию 3000) и проксируется через туннель. MAX ожидает **HTTP 200** в течение 30 сек. Секрет: при подписке передаётся `secret`, MAX шлёт его в заголовке `X-Max-Bot-Api-Secret` каждого вебхук-запроса.
- **Лимиты Max**: 30 rps глобально, **2 сообщения/сек в один чат/диалог/канал**.
- **Отправка сообщения**: `POST /messages` с query `chat_id` и телом `NewMessageBody { text, format?: 'markdown'|'html', link?: {...} }`. Текст — до 4000 символов. В SDK через `bot.api.sendMessageToChat(chatId, text, extra)` или `ctx.reply`, если есть контекст.

## Что нужно создать в этом шаге

### 1. `package.json`
Dependencies:
- `@maxhub/max-bot-api` (последняя стабильная)
- `express`
- `better-sqlite3`
- `@anthropic-ai/sdk`
- `dotenv`
- `music-metadata`

DevDependencies:
- `typescript`
- `tsx`
- `@types/express`
- `@types/better-sqlite3`
- `@types/node`

Scripts:
- `dev`: `tsx watch src/index.ts`
- `build`: `tsc`
- `start`: `node dist/index.js`
- `subscribe`: `tsx scripts/subscribe.ts`

### 2. `tsconfig.json` — strict mode, ES2022/NodeNext, outDir `dist`, rootDir `.`, include `src` и `scripts`.

### 3. `.env.example`
Поля: `BOT_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `PORT`, `DB_PATH`. С комментариями, что куда. НЕ создавай `.env` (только example).

### 4. `src/config.ts`
Чтение env через `dotenv`. Экспортирует типизированный объект `config` с валидацией обязательных полей (`BOT_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_SECRET`) — если отсутствуют, throw с понятным сообщением. Остальные поля с дефолтами (`PORT=3000`, `DB_PATH=./data.db`). Функция `log(msg)` — `console.log` с ISO-timestamp.

### 5. `src/rateLimiter.ts`
Токен-бакет на 30 rps (глобально) + задержка ≥500ms между отправками в один `chat_id` (лимит 2 msg/sec per-чат).
- Экспортируй `createRateLimiter()` → объект с методом `async sendToChat(chatId, fn)`, где `fn` возвращает Promise. Внутри:
  - общий бакет: вместимость 30, пополнение 30 токенов/сек.
  - per-чат очередь: гарантировать минимум 500ms между последовательными вызовами для одного `chat_id`.
- Реализация без внешних библиотек, на `setTimeout`/`Promise` + `Date.now()`.
- Комментарии на русском: как работает бакет и per-чат задержка.

### 6. `src/maxClient.ts`
Тонкая обёртка над SDK + rate limiter + простой HTTP-вызов `POST /subscriptions` (через `fetch`, т.к. подписка — административный вызов, удобно держать отдельно; SDK тоже можно — выбери то, что реально экспортируется).
- Создаёт `Bot` из `@maxhub/max-bot-api`.
- `sendMessage(chatId, text, extra?)` — проходит через `rateLimiter.sendToChat(chatId, () => bot.api.sendMessageToChat(chatId, text, extra))`. Логирование исходящего сообщения (chatId, длина текста).
- `subscribeWebhook(url, updateTypes, secret)` — `POST https://platform-api2.max.ru/subscriptions` с заголовком `Authorization: {BOT_TOKEN}` и JSON-телом `{ url, update_types, secret }`. Возвращает результат. Проверь: если в SDK есть готовый метод подписки — используй его и просто вызови из обёртки.
- `getBot()` — возвращает инстанс `Bot` (нужен для шага 6).

### 7. `src/webhook.ts`
Express-приложение.
- `POST /webhook`:
  - Проверка заголовка `X-Max-Bot-Api-Secret` → если не равен `config.webhookSecret`, ответ `401` и вернуть (без обработки).
  - Распарсить `Update` из `req.body`.
  - Логирование: `log(…)` с `update_type`, `chat_id` (если есть) и `timestamp`.
  - **Роутинг (пока минимальный)**: если `update_type === 'bot_started'` → отправить приветствие `maxClient.sendMessage(chatId, "Привет! Я персональный ассистент в этом чате. ...")` (краткое описание 3 функций). Остальные `update_type` — только логировать.
  - Любые ошибки внутри обработки — `try/catch`, логировать, но **всегда отвечать 200** (чтобы MAX не повторял), можно `200` с пустым телом.
  - Должен ответить **в пределах 30 сек** — не делай долгих await без таймаута на этом этапе (хендлеры добавятся в шаге 6, пока только bot_started).
- Экспортируй функцию `createApp(maxClient)` или экспортируй сам `app`.

### 8. `src/index.ts` — точка входа.
- Импорт config, создание maxClient, `createApp`, `app.listen(config.port)`.
- Логирование факта старта (`Listening on port …`).
- При `SIGINT`/`SIGTERM` — корректно закрыть соединения.

### 9. `scripts/subscribe.ts`
Вызывает `maxClient.subscribeWebhook(config.webhookUrl, ['message_created','bot_started'], config.webhookSecret)` и логирует результат. Запускается через `npm run subscribe`.

## Edge-cases (реализуй)
- (а) Приход Update с неизвестным `update_type` → логировать и `200 OK`, не падать.
- (б) `X-Max-Bot-Api-Secret` не совпадает → `401` без обработки.
- (в) Запрос на путь кроме `/webhook` → Express `404` (по умолчанию).
- (г) `bot_started` → приветственное сообщение.

## Критерии готовности
- `npm install` устанавливает зависимости без ошибок.
- `npx tsc --noEmit` проходит без TS-ошибок.
- `npm run dev` поднимает Express и логирует «Listening on port 3000».
- Файлы созданы: `package.json`, `tsconfig.json`, `.env.example`, `src/config.ts`, `src/rateLimiter.ts`, `src/maxClient.ts`, `src/webhook.ts`, `src/index.ts`, `scripts/subscribe.ts`.

## Если экспорты SDK отличаются
Если `@maxhub/max-bot-api` не экспортирует ожидаемые методы/типы (например `sendMessageToChat`, типы `Update`/`Message`):
1. Загляни в `node_modules/@maxhub/max-bot-api/dist` (или `src`) после `npm install` — найди реальные экспорты.
2. Адаптируй заголовки импортов под реальные типы. Если у SDK есть `RawApi` или низкоуровневый вызов — используй его.
3. Если SDK действительно не покрывает подписку — реализуй `subscribeWebhook` через нативный `fetch`.
4. Не выдумывай поля — только то, что реально в SDK или в блоке «Схема объектов Max» выше.

Не оставляй TODO/FIXME на местах, которые можно реально проверить в node_modules.
