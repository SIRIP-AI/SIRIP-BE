import type { RequestHandler } from 'express';
import { Router } from 'express';

import type { LoginCredentials } from '../../domain/auth/auth';
import { RequestError } from '../../domain/setup/errors';
import type { AuthService } from '../auth/auth-service';

const cookieName = 'sirip_session';

function cookieValue(header: string | undefined) {
  const cookie = header?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`));
  return cookie ? decodeURIComponent(cookie.slice(cookieName.length + 1)) : null;
}

function credentials(body: unknown): LoginCredentials {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Request body must be an object', 400);
  const { email, password } = body as Record<string, unknown>;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) throw new RequestError('email must be a valid email address', 400);
  if (typeof password !== 'string' || !password || password.length > 200) throw new RequestError('password is required', 400);
  return { email: normalizedEmail, password };
}

function sessionCookie(token: string, expiresAt: Date) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function createAuthRouter(auth: AuthService) {
  const router = Router();

  router.post('/login', async (request, response) => {
    const result = await auth.login(credentials(request.body));
    if (!result) throw new RequestError('Invalid email or password', 401);
    response.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt));
    response.json({ user: result.user });
  });

  router.get('/session', async (request, response) => {
    const token = cookieValue(request.headers.cookie);
    const user = token ? await auth.session(token) : null;
    if (!user) throw new RequestError('Authentication required', 401);
    response.json({ user });
  });

  router.delete('/session', async (request, response) => {
    const token = cookieValue(request.headers.cookie);
    if (token) await auth.logout(token);
    response.setHeader('Set-Cookie', clearSessionCookie());
    response.sendStatus(204);
  });

  return router;
}

export function requireAuth(auth: AuthService): RequestHandler {
  return async (request, _response, next) => {
    const token = cookieValue(request.headers.cookie);
    if (!token || !await auth.session(token)) throw new RequestError('Authentication required', 401);
    next();
  };
}
