# Промт для ИИ-агента — Шаг 4: Обработка перевода сообщений

> Это **четвёртый из 6 шагов**. Предполагается, что **Шаги 1-3 выполнены**: есть `src/maxClient.ts`, `src/llm.ts` (с `translate`), `src/handlers/voice.ts`. Команда БЕЗ интеграции в webhook — это шаг 6.

## Общие требования (обязательно прочти перед началом)
1. Проект: `C:\Work\Projects\bot-max-assistant\` (Windows PowerShell). TypeScript **strict**.
2. **Не выдумывай** поля объектов Max — только то, что ниже.
3. Комментарии на русском в ключевых местах логики.
4. Обработка ошибок на каждом внешнем вызове (Anthropic, отправка в чат) — `try/catch`, логирование, бот продолжает работать. В случае ошибки — отправить в чат короткое понятное сообщение.
5. Логирование: `console.log` с ISO-timestamp (`new Date().toISOString()`).
6. При завершении: запусти `npx tsc --noEmit` и убедись, что TS-ошибок нет; если есть — исправь.
7. **НЕ создавай** новые промт-файлы, не редактируй `bot-max-assistant.md`, `logo.jpg`, другие промт-файлы, `.kilo/`. Не ломай файлы шагов 1-3.
8. В конце сообщи: какие файлы создал/изменил и команду проверки (`npx tsc --noEmit`).

## Схема объектов Max (релевантно для этого шага)
- **Message**: `{ sender?, recipient: { chat_id, chat_type }, timestamp, link?: LinkedMessage | null, body: { mid, seq, text, attachments } }`.
- **LinkedMessage**: `{ type: 'reply' | 'forward', sender?: User, chat_id?: number, message: MessageBody }`.
  - Reply检测: `message.link?.type === 'reply'`.
  - Текст исходного сообщения (на которое сделан reply): `message.link?.message?.body?.text`.
- Текст самого сообщения (перевод-триггер): `message.body.text`.
- `chat_id` → из `message.recipient.chat_id`.

## Триггеры перевода
Сообщение является триггером перевода, если выполнено **любое из**:
1. Reply на сообщение **И** текст триггера равен (case-insensitive, trimmed) «переведи».
2. Reply на сообщение **И** текст триггера начинается с `/translate` (с опциональным аргументом, например `/translate раз`).

То есть обязательное условие — сообщение является **reply** на другое сообщение. Без reply триггер не срабатывает.

## Что нужно создать в этом шаге

### `src/handlers/translate.ts`
Экспортируй `async function handleTranslate(message: Message): Promise<boolean>` (возвращает `true`, если сообщение было триггером перевода и обработано; `false` — если не триггер, чтобы шаг 6 в роутинге мог продолжить). Тип `Message` импортируй из `@maxhub/max-bot-api` или локального файла типов шага 1.

Логика:
1. **Проверка reply**: если `message.link?.type !== 'reply'` → `return false` (не триггер).
2. **Проверка текста триггера**: `const t = (message.body.text ?? '').trim().toLowerCase()`. Условие: `t === 'переведи'` **ИЛИ** `t.startsWith('/translate')`. Если нет → `return false`.
3. **Взять текст исходного сообщения** (на которое сделан reply): `const source = message.link?.message?.body?.text?.trim()`.
   - Если `source` пустой/undefined → отправить в чат: «Нет текста для перевода» → `return true`.
4. **Anthropic-перевод**: `llm.translate(source)` (функция из `src/llm.ts` шага 2 — автоопределение языка, перевод на русский, сохраняя тон и стиль).
   - Если в `llm.translate` реализована пометка «уже русский» — возвращается исходник с заметкой; это нормально, отправляем как есть.
5. **Отправить перевод в чат** через `maxClient.sendMessage(chatId, translation)` БЕЗ дополнительных пометок (только текст перевода — как требует ТЗ). Если Anthropic вернул с пометкой про русский — отправь как есть (это допустимое поведение по edge-case (в) ниже).
   - Если перевод дольше 4000 символов — обрезать до 3900 символов с суффиксом `…`, логировать.
6. `return true`.

## Edge-cases (реализуй)
- (а) Сообщение не является reply → `return false` (игнор хендлером, другие хендлеры могут сработать).
- (б) Reply на исходник без текста (только вложение, `message.link.message.body.text` пустой/отсутствует) → ответить «Нет текста для перевода», `return true` (сообщение было триггером, обработано).
- (в) Исходник уже на русском → Anthropic-`translate` возвращает текст с пометкой (реализовано в шаге 2); отправляем как есть. Логировать «текст уже на русском».
- (г) Ошибка Anthropic (после retry из шага 2) → логировать, ответить в чат «Не удалось перевести сообщение», `return true`.
- (д) Reply есть, триггер «переведи»/`/translate` выполнен, но `message.body.text` пустой на самом деле (edge) — считаем что триггер всё равно сработал минимально: бери исходник и переводи.

## Критерии готовности
- `npx tsc --noEmit` без ошибок.
- Файл создан: `src/handlers/translate.ts`.
- Хендлер экспортирует `handleTranslate(message)` и возвращает `boolean`.
- Все edge-cases покрыты; ошибки не роняют процесс.

## Если экспорты `@maxhub/max-bot-api` типа `Message`/`LinkedMessage` отличаются
- Проверь `node_modules/@maxhub/max-bot-api` — реальные экспорты.
- Если `link.message.body.text` недоступен по типам, используй структурную проверку (как в шаге 3):
  ```ts
  type LinkedMessageLike = { type: string; message?: { body?: { text?: string | null } } };
  const link = message.link as LinkedMessageLike | null | undefined;
  ```
- `maxClient.sendMessage` из шага 1; прочитай `src/maxClient.ts` и адаптируй вызов, если сигнатура иная.
