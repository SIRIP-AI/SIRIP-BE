import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { hashPassword } from '../auth/crypto';
import { createDatabase } from './database';
import { resetSeedBaseline, seededUser } from './seed-baseline';

if (existsSync('.env')) loadEnvFile('.env');

async function seed() {
  const database = createDatabase();
  const passwordHash = await hashPassword(seededUser.password);

  try {
    await database.$transaction(async (transaction) => {
      const user = await transaction.user.upsert({
        where: { email: seededUser.email },
        update: { name: seededUser.name, phone: seededUser.phone, passwordHash },
        create: { name: seededUser.name, email: seededUser.email, phone: seededUser.phone, passwordHash },
      });

      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${user.id})`;
      await transaction.authSession.deleteMany({ where: { userId: user.id } });
      await resetSeedBaseline(transaction, user.id);
    });
    console.log(`Seeded clean provisioning baseline for ${seededUser.email}`);
  } finally {
    await database.$disconnect();
  }
}

seed().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Seed failed');
  process.exitCode = 1;
});
