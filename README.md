# Bot Max Assistant

Персональный ассистент для мессенджера Max: транскрибация и саммари голосовых сообщений, перевод, саммари обсуждений.

## Технологии

**Бэкенд (Node.js + TypeScript)**
- **Node.js 20+** — рантайм (нативный `fetch`, `FormData`, `Blob`)
- **TypeScript 5** — типизированный код; сборка через `tsc`
- **Express 4** — HTTP-сервер и роутинг вебхуков
- **@maxhub/max-bot-api** — официальный клиент Bot API мессенджера Max
- **better-sqlite3** — синхронное хранилище SQLite (хранение и выборка сообщений)
- **dotenv** — загрузка переменных окружения из `.env`
- **music-metadata** — чтение метаданных (длительность и формат) аудио-вложений
- **tsx** — запуск TypeScript «на лету» в dev-режиме
- **cross-env** — кросс-платформенная установка переменных окружения

**LLM-интеграция**
- **OpenAI-совместимый Chat Completions API** — саммари, перевод и генерация текста (по умолчанию `gpt-4o-mini`, базовый URL и модель настраиваются); реализованы собственные retry с экспоненциальным backoff
- **Hugging Face Inference API (serverless)** — альтернативный бекенд транскрибации для стандартных ASR-моделей (Whisper, Slidecasting, и др.); требует `HF_API_KEY`
- **Groq Whisper API** — серверless Whisper (OpenAI-compatible `/v1/audio/transcriptions`); free tier ~10 тыс. токенов/час; требует `GROQ_API_KEY`
- **GigaAM Multilingual (Сбер)** — локальная транскрибация (бекенд `local`)

**Локальный сервис транскрибации (Python)**
- **FastAPI + Uvicorn** — HTTP-сервис транскрибации
- **PyTorch / torchaudio + transformers** — инференс модели `waveletdeboshir/gigaam-ctc`
- **Hugging Face Hub** — скачивание предобученной модели
- **ffmpeg-python** — конвертация аудио
- **numpy / safetensors / python-multipart** — вспомогательные библиотеки и приём multipart-файлов

**Инфраструктура**
- **Ngrok / cloudflared** — HTTPS-туннели для локальной разработки (Max требует HTTPS от доверенного ЦС)
- **Webhooks** — подписка на события `message_created`, `bot_started` с секретной подписью

## Требования

- Node.js 20+ (нужен нативный `fetch`)
- Python 3.10+ с `pip` (локальный сервис GigaAM для транскрибации)
- Бот в Max (токен из [business.max.ru/self](https://business.max.ru/self) или мини-приложение «MAX для бизнеса»)
- API-ключ OpenAI-совместимого провайдера (LLM для саммари/перевода)
- API-ключ Hugging Face (`HF_API_KEY`, для бекенда `hf`)

## Установка

```bash
npm install
cp .env.example .env
```

### Бекенды транскрибации

Выбираются переменной `TRANSCRIBER_BACKEND` в `.env`:

#### `local` (по умолчанию) — локальный сервис GigaAM Multilingual

Создаёт локальный HTTP-сервис на FastAPI, который скачивает модель `waveletdeboshir/gigaam-ctc` с Hugging Face при первом запуске и транскрибирует аудио.

```bash
python -m venv .venv
.venv\\Scripts\\activate
pip install -r services/transcriber/requirements.txt
uvicorn services.transcriber.server:app --host 0.0.0.0 --port 8001
```

Проверьте работоспособность:

```bash
curl http://localhost:8001/health
```

## Заполните `.env`

- `BOT_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `WEBHOOK_URL`
- `WEBHOOK_SECRET`
- (опционально) `PORT`
- (опционально) `DB_PATH`
- `TRANSCRIBER_BACKEND=local` (или `hf`, `groq`)
- (для `local`) `TRANSCRIBER_URL=http://localhost:8001`
- (для `hf`) `HF_API_KEY` и (опционально) `HF_MODEL`
- (для `groq`) `GROQ_API_KEY` и (опционально) `GROQ_MODEL`

### `hf` — Hugging Face Inference API (без локального сервиса)

Позволяет обойтись без Python и GPU: транскрибация выполняется через serverless Hugging Face Inference API. Подходит для любой стандартной ASR-модели (по умолчанию `openai/whisper-base`).

Настройте в `.env`:
```bash
TRANSCRIBER_BACKEND=hf
HF_API_KEY=your_hf_api_key_here
HF_MODEL=openai/whisper-base
```

> GigaAM (`waveletdeboshir/gigaam-ctc`) не поддерживается serverless API, т.к. модель использует `trust_remote_code`. Для GigaAM используйте бекенд `local`.

### `groq` — Whisper через Groq (free tier)

Альтернативный serverless-вариант: транскрибация через Groq Whisper API (`whisper-large-v3`). Free tier — ~10 тыс. токенов/час (~8–12 минут аудио/час).

Настройте в `.env`:
```bash
TRANSCRIBER_BACKEND=groq
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=whisper-large-v3
```

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
- При бекенде `local` должен быть запущен локальный сервис GigaAM (`services/transcriber/server.py`).
- Модель GigaAM скачивается с Hugging Face при первом запуске сервиса (~500 МБ); работает только на CPU или GPU.
- При бекенде `hf` транскрипция идёт через Hugging Face Inference API; GigaAM не поддерживается (trust_remote_code), используйте бекенд `local` для него.

## Структура проекта

```
src/
  config.ts        — конфигурация и переменные окружения
  maxClient.ts     — клиент Max Bot API с rate limiter
  webhook.ts       — Express-сервер и роутинг вебхуков
  rateLimiter.ts   — глобальный и per-чат rate limiter
  db.ts            — SQLite: сохранение и выборка сообщений
  llm.ts           — OpenAI-совместимый LLM (саммари, перевод) + транскрибация (local/hf)
  handlers/
    voice.ts       — обработка голосовых сообщений
    translate.ts   — перевод сообщений по reply-триггеру
    summary.ts     — саммари обсуждения
  index.ts         — точка входа
scripts/
  subscribe.ts     — регистрация вебхука (npm run subscribe)
services/
  transcriber/     — локальный сервис транскрибации на FastAPI
```
