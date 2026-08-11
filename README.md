# Bot Max Assistant

Персональный ассистент для мессенджера Max: транскрибация и саммари голосовых сообщений, перевод, саммари обсуждений.

## Требования

- Node.js 18+ (нужен нативный `fetch`)
- Бот в Max (токен из [business.max.ru/self](https://business.max.ru/self) или мини-приложение «MAX для бизнеса»)
- API-ключ Anthropic
- API-ключ OpenAI (для Whisper)

## Установка

```bash
npm install
cp .env.example .env
```

Заполните `.env`:
- `BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `WEBHOOK_URL`
- `WEBHOOK_SECRET`
- (опционально) `PORT`
- (опционально) `DB_PATH`

## HTTPS-туннель для локальной разработки

Max не принимает HTTP и самоподписные сертификаты (требование платформы с 25 мая 2026):

```bash
ngrok http 3000
```

Получите `https://…ngrok.io` и выставите в `WEBHOOK_URL`.

Альтернатива: `cloudflared tunnel --url http://localhost:3000`.

Для production: валидный TLS-сертификат доверенного ЦС (в т.ч. сертификат Минцифры как опция).

## Регистрация webhook

Запустите сервер:

```bash
npm run dev
```

В другом терминале:

```bash
npm run subscribe
```

Или вручную через `curl`:

```bash
curl -X POST https://platform-api2.max.ru/subscriptions `
  -H "Authorization: <BOT_TOKEN>" `
  -H "Content-Type: application/json" `
  -d '{
    "url": "<WEBHOOK_URL>",
    "update_types": ["message_created", "bot_started"],
    "secret": "<WEBHOOK_SECRET>"
  }'
```

## Запуск

```bash
npm run dev
npm run build && npm start
```

## Команды бота

- Reply на сообщение с текстом `переведи` или `/translate` → перевод на русский.
- `/summary` → последние 50 сообщений; `/summary 50` → N; `/summary 24h` → за 24 часа.
- Голосовое сообщение → расшифровка (+ кратко, если длиннее 30 сек).

## Ограничения/примечания

- Лимит отправки Max: 30 rps, 2 msg/sec на чат — реализовано rate limiter'ом.
- Лимит текста сообщения: 4000 символов — саммари разбивается на несколько.

## Структура проекта

```
src/
  config.ts        — конфигурация и переменные окружения
  maxClient.ts     — клиент Max Bot API с rate limiter
  webhook.ts       — Express-сервер и роутинг вебхуков
  rateLimiter.ts   — глобальный и per-чат rate limiter
  db.ts            — SQLite: сохранение и выборка сообщений
  llm.ts           — Anthropic (Claude) + OpenAI Whisper
  handlers/
    voice.ts       — обработка голосовых сообщений
    translate.ts   — перевод сообщений по reply-триггеру
    summary.ts     — саммари обсуждения
  index.ts         — точка входа
scripts/
  subscribe.ts     — регистрация вебхука (npm run subscribe)
```
