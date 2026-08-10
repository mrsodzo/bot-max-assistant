/**
 * Rate limiter для работы с API Max.
 *
 * Реализует два ограничения:
 * 1. Глобальный токен-бакет на 30 rps — не более 30 запросов в секунду ко всему API.
 * 2. Per-чат задержку — минимум 500 мс между последовательными отправками в один chat_id,
 *    чтобы соблюсти лимит Max: 2 сообщения в секунду в один чат/диалог/канал.
 */
export interface RateLimiter {
  /**
   * Выполняет fn для отправки сообщения в chat_id, дождавшись
   * глобального и per-чат лимитов.
   */
  sendToChat<T>(chatId: number, fn: () => Promise<T>): Promise<T>;
}

interface ChatQueue {
  lastSendTime: number;
  pending: Array<{
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    fn: () => Promise<unknown>;
  }>;
}

export function createRateLimiter(): RateLimiter {
  // Параметры глобального токен-бакета (30 rps).
  const capacity = 30;
  const refillRatePerMs = 30 / 1000; // 30 токенов в секунду.
  let tokens = capacity;
  let lastRefill = Date.now();

  // Очереди по чатам для гарантии интервала ≥500 мс.
  const chatQueues = new Map<number, ChatQueue>();

  /**
   * Пополняет бакет на основе прошедшего времени.
   */
  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed > 0) {
      tokens = Math.min(capacity, tokens + elapsed * refillRatePerMs);
      lastRefill = now;
    }
  }

  /**
   * Забирает один токен из бакета, возвращая время ожидания в мс.
   */
  function acquireToken(): number {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    const needed = 1 - tokens;
    const waitMs = Math.ceil(needed / refillRatePerMs);
    // После ожидания бакет будет полностью пополнен на нужную величину;
    // для простоты считаем, что мы забираем токен после ожидания.
    tokens = 0;
    lastRefill += Math.ceil(needed / refillRatePerMs);
    return waitMs;
  }

  /**
   * Обрабатывает следующее ожидающее задание в очереди чата.
   */
  function processChatQueue(chatId: number): void {
    const queue = chatQueues.get(chatId);
    if (!queue || queue.pending.length === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceLastSend = now - queue.lastSendTime;
    const perChatDelay = 500;
    const chatWait = Math.max(0, perChatDelay - timeSinceLastSend);
    const tokenWait = acquireToken();
    const wait = Math.max(chatWait, tokenWait);

    const next = queue.pending.shift();
    if (!next) {
      return;
    }

    setTimeout(() => {
      queue.lastSendTime = Date.now();
      next
        .fn()
        .then((result) => {
          next.resolve(result);
        })
        .catch((error) => {
          next.reject(error);
        })
        .finally(() => {
          // Рекурсивно запускаем следующее задание после завершения текущего.
          processChatQueue(chatId);
        });
    }, wait);
  }

  return {
    sendToChat<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        let queue = chatQueues.get(chatId);
        if (!queue) {
          queue = { lastSendTime: 0, pending: [] };
          chatQueues.set(chatId, queue);
        }
        queue.pending.push({ resolve: resolve as (value: unknown) => void, reject, fn: fn as () => Promise<unknown> });
        // Если в очереди только одно задание — сразу начинаем обработку,
        // иначе оно будет обработано по цепочке.
        if (queue.pending.length === 1) {
          processChatQueue(chatId);
        }
      });
    },
  };
}
