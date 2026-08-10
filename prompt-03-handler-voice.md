# Промт для ИИ-агента — Шаг 3: Обработка голосовых сообщений

> Это **третий из 6 шагов**. Предполагается, что **Шаги 1 и 2 выполнены**: есть `src/config.ts`, `src/maxClient.ts`, `src/db.ts`, `src/llm.ts` (с `transcribeAudio`, `summarizeTranscript`), `package.json` с `music-metadata`. Команда голосового хендлера БЕЗ интеграции в webhook — это шаг 6.

## Общие требования (обязательно прочти перед началом)
1. Проект: `C:\Work\Projects\bot-max-assistant\` (Windows PowerShell). TypeScript **strict**.
2. **Не выдумывай** поля объектов Max и API — только то, что ниже.
3. Комментарии на русском в ключевых местах логики.
4. Обработка ошибок на каждом внешнем вызове (скачивание, чтение длительности, Whisper, Anthropic, отправка в чат) — `try/catch`, логирование, бот продолжает работать. В случае ошибки на любом этапе — отправить в чат короткое понятное сообщение, что не удалось обработать.
5. Логирование: `console.log` с ISO-timestamp (`new Date().toISOString()`).
6. При завершении: запусти `npx tsc --noEmit` и убедись, что TS-ошибок нет; если есть — исправь.
7. **НЕ создавай** новые промт-файлы, не редактируй `bot-max-assistant.md`, `logo.jpg`, другие промт-файлы, `.kilo/`. Не ломай файлы шагов 1-2.
8. В конце сообщи: какие файлы создал/изменил и команду проверки (`npx tsc --noEmit`).

## Схема объектов Max (релевантно для этого шага)
- **Message**: `{ sender?, recipient: { chat_id, chat_type }, timestamp, body: { mid, seq, text, attachments: Attachment[] | null } }`.
- **Attachment / AudioAttachment**: `{ type: 'audio', payload: { url: string, token: string } }`.
  - `payload.url` — **прямая ссылка для скачивания файла**. Отдельный метод Max API не нужен — качаем `fetch(payload.url)` → `arrayBuffer()` → `Buffer`.
  - ⚠️ У `AudioAttachment` **НЕТ поля `duration`**. Длительность определяем на стороне бота (см. ниже).
- Голосовое сообщение = в `message.body.attachments` есть элемент с `type === 'audio'`. Берём **первый** audio-attachment.
- `chat_id` → из `message.recipient.chat_id`.

## Что нужно создать в этом шаге

### `src/handlers/voice.ts`
Экспортируй `async function handleVoiceMessage(message: Message): Promise<void>` (тип `Message` импортируй из `@maxhub/max-bot-api` или из локального файла типов шага 1, если завели такой).

Логика:
1. **Найти audio-attachment**: `message.body.attachments?.find(a => a.type === 'audio')`. Если нет — `return` (не наш кейс, хендлер не должен вызываться в этом случае, но защите себя).
2. **Скачать файл**: `fetch(audio.payload.url)` → `arrayBuffer()` → `Buffer`. Таймаут на скачивание (рекомендую `AbortController` с ~60 сек). Имя файла и MIME — выведи из `payload.url` (расширение из пути; если не определяется —默认 `audio.mp3`/`audio/mpeg`).
3. **Определить длительность**: через `music-metadata` (`parseBuffer` либо `parseBlob`). Достать `format.duration` (в секундах). Обёрнуть в `try/catch` — если не удалось, **fallback: conservative** = всегда прогонять саммари (считаем «длинное», переходим к шагу 5).
4. **Whisper**: `llm.transcribeAudio(buffer, filename, mimeType)` → текст. Логирование длительности транскрибации.
5. **Доп. саммари еслиlonger than threshold**:
   - Если длительность > 30 сек **ИЛИ** не удалось определить длительность (fallback) → дополнительно `llm.summarizeTranscript(transcript)`.
   - Если длительность ≤ 30 сек — пропускаем саммари.
6. **Формат ответа** (отправить через `maxClient.sendMessage(chatId, text, { format: 'markdown' })`):
   - Базово: `📝 Расшифровка: {transcript}`
   - Если есть саммари — дополнительно строка: `💡 Кратко: {summary}`
   - Объедини в одно сообщение: `📝 Расшифровка: …\n\n💡 Кратко: …`.
7. **Вызывать отправку через `maxClient.sendMessage`** (он сам проходит через rate limiter шага 1).

## Edge-cases (реализуй)
- (а) `attachments` нет или нет `audio` → `return` (хендлер не активируется).
- (б) `payload.url` пустой или скачивание упало → логировать ошибку, отправить в чат: «Не удалось получить голосовое сообщение».
- (в) Whisper вернул пустую/пробельную транскрипцию → ответить «Не удалось распознать речь».
- (г) Не удалось прочитать длительность через `music-metadata` → fallback: всегда прогонять саммари (conservative).
- (д) Транскрипция дольше 4000 символов или итог с саммари > 4000 — обрезать транскрипцию до разумного предела (например 3500 символов) с суффиксом `…` и всё равно пытаться саммари; если итог всё ещё >4000 — обрезать итог до 3900 символов с `…`. Логировать факт обрезки.
- (е) Ошибка на этапе Anthropic-саммари (после успешного Whisper) — всё равно отправить `📝 Расшифровка: …` без блока «Кратко», не терять расшифровку из-за сбоя саммари.

## Критерии готовности
- `npx tsc --noEmit` без ошибок.
- Файл создан: `src/handlers/voice.ts`.
- Хендлер экспортирует `handleVoiceMessage(message)`.
- Все edge-cases покрыты: ошибки скачивания/распознавания/Anthropic не роняют процесс; fallback длительности реализован.

## Если экспорты `@maxhub/max-bot-api` типа `Message`/`Attachment` отличаются
- Проверь `node_modules/@maxhub/max-bot-api` — реальные экспорты типов.
- Если тип `Attachment` не определён как union с `'audio'`, используй структурную проверку: `a.type === 'audio'` и доступ к `a.payload.url` через `any`-каст только если типы не дают; лучше определи локальный минимальный тип в этом файле:
  ```ts
  type AudioAttachmentLike = { type: 'audio'; payload: { url: string; token: string } };
  ```
  и находи через `(a) => (a as AudioAttachmentLike).type === 'audio'`. Не выдумывай поля сверх `{ type, payload: { url, token } }`.
- `maxClient.sendMessage` — создан в шаге 1; использует SDK. Если сигнатура иная — прочитай `src/maxClient.ts` и адаптируй вызов.
