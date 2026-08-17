import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionCookie } from './auth-router';

test('secures production cookies unless explicitly disabled', () => {
  const nodeEnv = process.env.NODE_ENV;
  const cookieSecure = process.env.COOKIE_SECURE;
  process.env.NODE_ENV = 'production';
  delete process.env.COOKIE_SECURE;
  assert.match(sessionCookie('token', new Date(0)), /; Secure$/);
  process.env.COOKIE_SECURE = 'false';
  assert.doesNotMatch(sessionCookie('token', new Date(0)), /; Secure$/);
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (cookieSecure === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = cookieSecure;
});
