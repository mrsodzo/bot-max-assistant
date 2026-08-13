import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './config.js';

/**
 * Загружает дополнительный корневой сертификат (например, Минцифры) в
 * глобальный https.Agent.
 *
 * Используется как fallback, если переменная NODE_EXTRA_CA_CERTS не задана
 * или не работает в контейнере хостинга.
 */
export function loadExtraCaCert(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) {
    // Node.js загрузит сертификат сам, если переменная задана.
    return;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Ищем trusted_root_ca.cer в корне проекта (dev) или рядом с dist/ (prod)
  const candidates = [
    path.resolve(__dirname, '..', 'trusted_root_ca.cer'), // dev: src/../trusted_root_ca.cer
    path.resolve(__dirname, '..', '..', 'trusted_root_ca.cer'), // prod: dist/src/../../trusted_root_ca.cer
  ];
  const certPath = candidates.find((p) => fs.existsSync(p));
  if (!certPath) {
    log('loadExtraCaCert: trusted_root_ca.cer не найден, пропускаем');
    return;
  }

  const pem = fs.readFileSync(certPath, 'utf8');
  const existing = https.globalAgent.options.ca;
  if (Array.isArray(existing)) {
    https.globalAgent.options.ca = [...existing, pem];
  } else if (existing) {
    https.globalAgent.options.ca = [existing as string, pem];
  } else {
    https.globalAgent.options.ca = pem;
  }
  log(`loadExtraCaCert: загружен сертификат из ${certPath}`);
}
