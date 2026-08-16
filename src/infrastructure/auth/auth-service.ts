import { randomBytes } from 'node:crypto';

import type { AuthUser, LoginCredentials } from '../../domain/auth/auth';
import type { Database } from '../persistence/database';
import { hashToken, verifyPassword } from './crypto';

const sessionLifetimeMs = 8 * 60 * 60 * 1000;

function authUser(user: { id: bigint; name: string; email: string; phone: string }): AuthUser {
  return { id: user.id.toString(), name: user.name, email: user.email, phone: user.phone };
}

export class AuthService {
  constructor(private readonly database: Database) {}

  async login(credentials: LoginCredentials) {
    const user = await this.database.user.findUnique({ where: { email: credentials.email.toLowerCase() } });
    if (!user || !await verifyPassword(credentials.password, user.passwordHash)) return null;

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    await this.database.authSession.create({ data: { tokenHash: hashToken(token), userId: user.id, expiresAt } });
    return { token, expiresAt, user: authUser(user) };
  }

  async session(token: string) {
    const session = await this.database.authSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!session) return null;
    if (session.expiresAt <= new Date()) {
      await this.database.authSession.delete({ where: { tokenHash: session.tokenHash } });
      return null;
    }
    return authUser(session.user);
  }

  async logout(token: string) {
    await this.database.authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
}
