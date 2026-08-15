import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../generated/prisma/client';

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type Database = ReturnType<typeof createDatabase>;
