# Промт для ИИ-агента — Шаг 6: Интеграция хендлеров + README

> Это **последний, шестой из 6 шагов**. Предполагается, что **Шаги 1-5 выполнены**: есть `src/config.ts`, `src/maxClient.ts`, `src/webhook.ts`, `src/rateLimiter.ts`, `src/db.ts`, `src/llm.ts`, `src/handlers/voice.ts`, `src/handlers/translate.ts`, `src/handlers/summary.ts`, `src/index.ts`, `scripts/subscribe.ts`, `package.json`, `tsconfig.json`, `.env.example`. Этот шаг **интегрирует всё** в роутинг webhook'а, добавляет `setMyCommands`, единый error boundary и пишет `README.md`.

## Общие требования (обязательно прочти перед началом)
1. Проект: `C:\Work\Projects\bot-max-assistant\` (Windows PowerShell). TypeScript **strict**. Используем `@maxhub/max-bot-api`.
2. **Не выдумывай** поля объектов Max — только то, что ниже.
3. Комментарии на русском в ключевых местах логики.
4. Обработка ошибок на **каждом** Update: `try/catch` вокруг всей обработки одного Update. Ошибка в одном хендлере НЕ должна ронять обработку следующих Update и НЕ должна приводить к 5xx (всегда 200, MAX не любит повторов).
5. Логирование: `console.log` с ISO-timestamp (`new Date().toISOString()`) для входящих Update и исходящих ответов.
6. При завершении: запусти `npx tsc --noEmit` **и** `npm run build` — убедись, что оба проходят без ошибок; если есть — исправь.
7. **НЕ создавай** новые промт-файлы, не редактируй `bot-max-assistant.md`, `logo.jpg`, другие промт-файлы, `.kilo/`.
8. В конце сообщи: какие файлы создал/изменил, команды проверки (`npx tsc --noEmit`, `npm run build`) и краткую инструкцию, как запустить бота end-to-end (2-3 команды).

## Схема объектов Max (полная картина для роутинга)
- **Update** (`message_created`): `{ update_type: 'message_created', timestamp, message: Message, user_locale? }`.
- **Update** (`bot_started`): `{ update_type: 'bot_started', timestamp, chat_id, user }`.
- Остальные `update_type`: логировать и `200 OK` (не падать).
- **Message**: `{ sender?, recipient: { chat_id, chat_type }, timestamp, link?, body: { mid, seq, text, attachments } }`.
  - `chat_id` → `message.recipient.chat_id`.
  - Reply-цель: `message.link?.type === 'reply'` → `message.link.message.body.text`.
  - Голосовое: `message.body.attachments?.some(a => a.type === 'audio')`.
  - Текст: `message.body.text`.

## Что нужно сделать в этом шаге

### 1. Доработать `src/webhook.ts` — полный роутинг `message_created`
После проверки секрета и логирования Update (уже есть из шага 1) роутить `message_created`:

Порядок проверки внутри `try/catch` (важен — первые совпадения перехватывают):
1. **Перевод**: `await handleTranslate(message)` → если вернул `true`, стоп (уже ответил).
2. **Саммари**: `await handleSummary(message)` → если `true`, стоп.
3. **Голосовое**: если `message.body.attachments?.some(a => a.type === 'audio')` → `await handleVoiceMessage(message)`, стоп.
4. **Сохранение текста в БД** (для будущих саммари): для **обычных текстовых** сообщений (не триггеры перевода/саммари, не голосовые) → `db.saveMessage({ chat_id, message_id: body.mid, sender_id, sender_name, text: body.text, timestamp })`. `sender_id`/`sender_name` из `message.sender` (если есть). Если `body.text` пустой — не сохраняем (это логика шага 2, но уточни тут).
5. Если ни один хендлер не сработал и текста нет — тихо вернуться (200 OK).

⚠️ Роутинг порядка: перевод и саммари должны проверяться по **тексту команды**(translate по reply-триггеру, summary по `/summary`). Голосовое — по наличию `audio`-аттача. Обычное текстовое сохраняется в БД только если не было обработано хендлером (иначе в БД попадёт «переведи»/`/summary`, что засоряет саммари).

**Edge по порядку**: голосовое-сообщение с командой `/summary` в тексте — маловероятно, но **сначала voice** (т.к. reply-триггер перевода сам по себе требует reply, а `/summary` без reply → summary сработает раньше voice). Если `audio`-аттач есть **и** есть текст команды — приоритет за голосовым (оно содержит расшифровку, важнее). Другими словами: голосовое проверять **выше** summary, но **после** translate/summary если у Вас есть опасение конфликтов — фактически ставь voice **первым** при наличии audio-аттача и **после** translate/summary по тексту, чтобы fray обычное сообщение-команда сохранялось в БД корректно.

Рекомендуемый финальный порядок (фиксируй именно этот):
1. `handleTranslate(message)` — если `true`, return.
2. `handleSummary(message)` — если `true`, return.
3. Если есть `audio`-аттач → `handleVoiceMessage(message)`, return.
4. Если есть непустой `body.text` → `db.saveMessage(...)`, return.
5. Иначе return (200 OK).

### 2. `src/index.ts` — `setMyCommands` при старте
- После инициализации maxClient и БД (из шага 2), перед `app.listen`, вызвать один раз `bot.api.setMyCommands` (или аналог через `maxClient`) с командами:
  - `{ name: 'translate', description: 'Перевести сообщение, на которое сделан reply (или просто reply с «переведи»)' }`
  - `{ name: 'summary', description: 'Саммари обсуждения: /summary, /summary 50, /summary 24h' }`
- Обернуть в `try/catch`, ошибка не должна ронять старт.
- Логировать успех/ошибку регистрации команд.

### 3. Унифицированное логирование
- В `src/webhook.ts`: при входе Update логировать `[IN] {update_type} chat={chatId} ts={timestamp}`.
- При каждом исходящем сообщении (`maxClient.sendMessage`) уже логируется из шага 1 — проверь, что не дублируется излишне.
- При ошибке хендлера: `[ERR] {update_type} {error.message}` — но **всегда отвечать 200** в конце `POST /webhook`, чтобы MAX не повторял.

### 4. `README.md` — инструкция end-to-end
Структура:
1. **Назначение**: персональный ассистент в групповом чате Max: транскрибация/саммари голосовых, перевод, саммари обсуждения.
2. **Требования**: Node.js 18+ (нужен нативный `fetch`), бот в Max (токен из [business.max.ru/self](https://business.max.ru/self) или мини-приложения «MAX для бизнеса»), API-ключ Anthropic, API-ключ OpenAI (для Whisper).
3. **Установка**:
   - `npm install`
   - `cp .env.example .env` (Windows: `Copy-Item .env.example .env`) и заполнить `BOT_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, (опц.) `PORT`, `DB_PATH`.
4. **HTTPS-туннель для локальной разработки** (Max НЕ принимает HTTP и самоподписные сертификаты — требование платформы с 25 мая 2026):
   - `ngrok http 3000` → получить `https://…ngrok.io`, выставить `WEBHOOK_URL`.
   - Альтернатива: `cloudflared tunnel --url http://localhost:3000`.
   - Для production: валидный TLS-сертификат доверенного ЦС (в т.ч. сертификат Минцифры как опция, т.к. Max — российская платформа).
5. **Регистрация webhook** (один раз после поднятия туннеля и сервера):
   - Запустить сервер: `npm run dev`.
   - В другом терминале: `npm run subscribe` — вызовет `POST /subscriptions` с `update_types: ["message_created","bot_started"]` и секретом из `.env`.
   - Или вручную через `curl` (приведи пример с заголовком `Authorization: <token>`).
6. **Запуск**:
   - dev: `npm run dev` (tsx watch).
   - production: `npm run build && npm start`.
7. **Команды бота**:
   - Reply на сообщение с текстом `переведи` или `/translate` → перевод на русский.
   - `/summary` → последние 50 сообщений; `/summary 50` → N; `/summary 24h` → за 24 часа.
   - Голосовое сообщение → расшифровка (+ кратко, если длиннее 30 сек).
8. **Ограничения/примечания**:
   - Лимит отправки Max: 30 rps, 2 msg/sec на чат — реализовано rate limiter'ом.
   - Лимит текста сообщения: 4000 символов — саммари разбивается на несколько.
9. **Структура проекта** (краткий список файлов и их роли).

### 5. Пройтись по всем файлам и убедиться, что импорты согласованы
- Проверь, что `webhook.ts` импортирует хендлеры (`voice`, `translate`, `summary`) и `db`.
- Проверь, что `maxClient.sendMessage` вызывается идентично во всех хендлерах (сигнатура единственная — из шага 1).
- Удали мёртвый код/TODO из шагов 1-5.

## Edge-cases (реализуй)
- (а) Одна ошибка в хендлере не валит обработку следующих Update — `try/catch` вокруг всей обработки одного `message_created` в `POST /webhook`, логирование, **всегда 200**.
- (б) `setMyCommands` вызывается один раз при старте (в `index.ts`), ошибка не роняет старт.
- (в) В README указан сертификат Минцифры как опция для production.
- (г) При `bot_started` (из шага 1) — приветствие остаётся; не трогай.
- (д) `message_created` без `message` (маловероятно) — логировать и 200.
- (е) Неизвестный `update_type` — логировать и 200 (уже из шага 1, проверь что сохранилось).

## Критерии готовности
- `npx tsc --noEmit` без ошибок.
- `npm run build` без ошибок (`dist/` генерируется).
- `src/webhook.ts` роутит все 3 хендлера + сохранение обычных текстов в БД.
- `src/index.ts` регистрирует команды при старте.
- `README.md` создан и описывает полный цикл запуска.
- Финальное сообщение агента содержит список изменённых файлов, команды проверки и краткую инструкцию запуска (3-4 команды).

## Финальная проверка списка файлов проекта
После всех 6 шагов в `src/` должны быть: `config.ts`, `rateLimiter.ts`, `maxClient.ts`, `db.ts`, `llm.ts`, `webhook.ts`, `index.ts`, `handlers/voice.ts`, `handlers/translate.ts`, `handlers/summary.ts`. В корне: `package.json`, `tsconfig.json`, `.env.example`, `README.md`, `scripts/subscribe.ts`. Если чего-то нет — создай/восстанови.
