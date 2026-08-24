import type { RequestHandler } from 'express';
import { Router } from 'express';

import type { AuthUser, LoginCredentials, RegistrationInput } from '../../domain/auth/auth';
import { RequestError } from '../../domain/errors';
import type { AuthService } from './auth-service';

const cookieName = 'sirip_session';

export type AuthLocals = { user: AuthUser };

function cookieValue(header: string | undefined) {
  const cookie = header?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`));
  return cookie ? decodeURIComponent(cookie.slice(cookieName.length + 1)) : null;
}

function bodyObject(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Isi permintaan harus berupa objek', 400);
  return body as Record<string, unknown>;
}

function credentials(body: unknown): LoginCredentials {
  const { email, password } = bodyObject(body);
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) throw new RequestError('email harus berupa alamat email yang valid', 400);
  if (typeof password !== 'string' || !password || password.length > 200) throw new RequestError('password wajib diisi', 400);
  return { email: normalizedEmail, password };
}

function registration(body: unknown): RegistrationInput {
  const value = bodyObject(body);
  const login = credentials(value);
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const phone = typeof value.phone === 'string' ? value.phone.trim() : '';
  if (!name || name.length > 100) throw new RequestError('name wajib diisi dan maksimal 100 karakter', 400);
  if (!/^\+?[0-9][0-9 ()-]{6,19}$/.test(phone)) throw new RequestError('phone harus berupa nomor telepon yang valid', 400);
  if (login.password.length < 8) throw new RequestError('password minimal 8 karakter', 400);
  return { ...login, name, phone };
}

function secureCookie() {
  return process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
}

export function sessionCookie(token: string, expiresAt: Date) {
  const secure = secureCookie() ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

function clearSessionCookie() {
  const secure = secureCookie() ? '; Secure' : '';
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function createAuthRouter(auth: AuthService) {
  const router = Router();

  router.post('/signup', async (request, response) => {
    const result = await auth.register(registration(request.body));
    if (!result) throw new RequestError('Akun dengan email tersebut sudah ada', 409);
    response.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt));
    response.status(201).json({ user: result.user });
  });

  router.post('/login', async (request, response) => {
    const result = await auth.login(credentials(request.body));
    if (!result) throw new RequestError('Email atau password tidak valid', 401);
    response.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt));
    response.json({ user: result.user });
  });

  router.get('/session', async (request, response) => {
    const token = cookieValue(request.headers.cookie);
    const user = token ? await auth.session(token) : null;
    if (!user) throw new RequestError('Autentikasi diperlukan', 401);
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
  return async (request, response, next) => {
    const token = cookieValue(request.headers.cookie);
    const user = token ? await auth.session(token) : null;
    if (!user) throw new RequestError('Autentikasi diperlukan', 401);
    (response.locals as AuthLocals).user = user;
    next();
  };
}
