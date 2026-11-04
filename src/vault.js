import crypto from 'node:crypto';
import { config } from './config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const SALT_BYTES = 16;
const PIN_HASH_BYTES = 32;

const cardKey = () => {
  if (!config.CARD_ENCRYPTION_KEY) throw new Error('CARD_ENCRYPTION_KEY is not set');
  return crypto.createHash('sha256').update(config.CARD_ENCRYPTION_KEY).digest();
};

// The sale ID is bound in as authenticated data, so a sealed card can't be moved to another sale.
export function sealCard(saleId, card) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, cardKey(), iv);
  cipher.setAAD(Buffer.from(saleId));
  const body = Buffer.concat([cipher.update(JSON.stringify(card), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

export function openCard(saleId, sealed) {
  const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv(ALGORITHM, cardKey(), iv);
  decipher.setAAD(Buffer.from(saleId));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(pin, salt, PIN_HASH_BYTES);
  return `${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

export function verifyPin(pin, stored) {
  const [salt, hash] = stored.split('.').map((part) => Buffer.from(part, 'base64url'));
  return crypto.timingSafeEqual(crypto.scryptSync(pin, salt, PIN_HASH_BYTES), hash);
}

export const newSecret = () => crypto.randomBytes(24).toString('base64url');
// Only the hash of a reveal link is stored, so a copied database can't open any card.
export const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('base64url');
