import { hashPassword } from '../auth/crypto';
import { createDatabase } from './database';

export const seededUser = {
  name: 'Adi Rahman',
  email: 'adi.rahman@sirip.id',
  phone: '+6281234567890',
  password: 'SiripDemo2026!',
};

async function seed() {
  const database = createDatabase();
  const passwordHash = await hashPassword(seededUser.password);

  try {
    await database.user.upsert({
      where: { email: seededUser.email },
      update: { name: seededUser.name, phone: seededUser.phone, passwordHash },
      create: { name: seededUser.name, email: seededUser.email, phone: seededUser.phone, passwordHash },
    });
    console.log(`Seeded ${seededUser.email}`);
  } finally {
    await database.$disconnect();
  }
}

seed().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Seed failed');
  process.exitCode = 1;
});
