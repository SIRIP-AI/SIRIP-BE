import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { hashPassword } from '../auth/crypto';
import { createDatabase } from './database';

if (existsSync('.env')) loadEnvFile('.env');

export const seededUser = {
  name: 'Adi Rahman',
  email: 'adi.rahman@sirip.id',
  phone: '+6281234567890',
  password: 'SiripDemo2026!',
};

const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

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

      await transaction.authSession.deleteMany({ where: { userId: user.id } });
      await transaction.plan.deleteMany({ where: { userId: user.id } });
      await transaction.operationalEvent.deleteMany({ where: { userId: user.id } });
      await transaction.temperatureReading.deleteMany({ where: { sensorSession: { batch: { userId: user.id } } } });
      await transaction.sensorSession.deleteMany({ where: { batch: { userId: user.id } } });
      await transaction.sensor.deleteMany({ where: { userId: user.id } });
      await transaction.batch.deleteMany({ where: { userId: user.id } });
      await transaction.fishingTrip.deleteMany({ where: { userId: user.id } });
      await transaction.coldStorage.deleteMany({ where: { userId: user.id } });
      await transaction.vehicle.deleteMany({ where: { userId: user.id } });
      await transaction.destination.deleteMany({ where: { userId: user.id } });

      await transaction.coldStorage.createMany({ data: [
        { userId: user.id, name: 'Cold Room 1', capacityKg: 1500, availableCapacityKg: 1500, operationalStatus: 'AVAILABLE' },
        { userId: user.id, name: 'Cold Room 2', capacityKg: 1000, availableCapacityKg: 1000, operationalStatus: 'AVAILABLE' },
      ] });

      await transaction.vehicle.createMany({ data: [
        { userId: user.id, code: 'TR-01', capacityKg: 1000, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('06:00'), availabilityEnd: time('16:00') },
        { userId: user.id, code: 'TR-02', capacityKg: 750, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('08:00'), availabilityEnd: time('18:00') },
        { userId: user.id, code: 'TR-03', capacityKg: 500, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: 'Short-haul deliveries only', availabilityStart: time('07:00'), availabilityEnd: time('15:00') },
      ] });

      await transaction.destination.createMany({ data: [
        { userId: user.id, name: 'Processor A', address: 'Tanjung Perak, Surabaya', travelMinutes: 45, receivingStart: time('08:00'), receivingEnd: time('16:00'), status: 'AVAILABLE', notes: 'Call 30 minutes before arrival' },
        { userId: user.id, name: 'Processor B', address: 'Sidoarjo', travelMinutes: 75, receivingStart: time('07:00'), receivingEnd: time('15:00'), status: 'AVAILABLE', notes: 'Grade confirmation required at receiving' },
        { userId: user.id, name: 'Processor C', address: 'Gresik', travelMinutes: 90, receivingStart: time('09:00'), receivingEnd: time('17:00'), status: 'AVAILABLE', notes: 'Use the cold-chain receiving dock' },
      ] });
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
