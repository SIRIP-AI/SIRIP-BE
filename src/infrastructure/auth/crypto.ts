import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, 'base64url');
  if (expected.length !== 64) return false;
  const actual = await deriveKey(password, Buffer.from(saltValue, 'base64url'), expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
