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
  const now = new Date();
  const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  try {
    await database.$transaction(async (transaction) => {
      const user = await transaction.user.upsert({
        where: { email: seededUser.email },
        update: { name: seededUser.name, phone: seededUser.phone, passwordHash },
        create: { name: seededUser.name, email: seededUser.email, phone: seededUser.phone, passwordHash },
      });

      await transaction.plan.deleteMany({ where: { userId: user.id } });
      await transaction.operationalEvent.deleteMany({ where: { userId: user.id } });
      await transaction.temperatureReading.deleteMany({ where: { sensorSession: { batch: { userId: user.id } } } });
      await transaction.sensorSession.deleteMany({ where: { batch: { userId: user.id } } });
      await transaction.batch.deleteMany({ where: { userId: user.id } });

      const fishingTrip = await transaction.fishingTrip.upsert({
        where: { code: 'FT-001' },
        update: { vesselName: 'KM Mina Jaya', startedAt: minutesFromNow(-3_600), endedAt: minutesFromNow(-720), status: 'COMPLETED' },
        create: { code: 'FT-001', vesselName: 'KM Mina Jaya', startedAt: minutesFromNow(-3_600), endedAt: minutesFromNow(-720), status: 'COMPLETED' },
      });
      const coldStorage = await transaction.coldStorage.upsert({
        where: { userId_name: { userId: user.id, name: 'Cold Room 1' } },
        update: { capacityKg: 500, availableCapacityKg: 220, status: 'AVAILABLE' },
        create: { userId: user.id, name: 'Cold Room 1', capacityKg: 500, availableCapacityKg: 220, status: 'AVAILABLE' },
      });
      const vehicle = await transaction.vehicle.upsert({
        where: { userId_code: { userId: user.id, code: 'TR-01' } },
        update: { capacityKg: 800, status: 'AVAILABLE', delayMinutes: 0, restriction: null, availableFrom: null },
        create: { userId: user.id, code: 'TR-01', capacityKg: 800, status: 'AVAILABLE', delayMinutes: 0 },
      });
      await transaction.vehicle.upsert({
        where: { userId_code: { userId: user.id, code: 'TR-02' } },
        update: { capacityKg: 800, status: 'DELAYED', delayMinutes: 90, restriction: 'Delayed at loading point', availableFrom: minutesFromNow(90) },
        create: { userId: user.id, code: 'TR-02', capacityKg: 800, status: 'DELAYED', delayMinutes: 90, restriction: 'Delayed at loading point', availableFrom: minutesFromNow(90) },
      });
      const destination = await transaction.destination.upsert({
        where: { userId_name: { userId: user.id, name: 'Processor B' } },
        update: { address: 'Tanjung Perak, Surabaya', travelMinutes: 45, receivingStart: new Date('1970-01-01T08:00:00.000Z'), receivingEnd: new Date('1970-01-01T16:00:00.000Z'), status: 'AVAILABLE', notes: 'Call before dispatch' },
        create: { userId: user.id, name: 'Processor B', address: 'Tanjung Perak, Surabaya', travelMinutes: 45, receivingStart: new Date('1970-01-01T08:00:00.000Z'), receivingEnd: new Date('1970-01-01T16:00:00.000Z'), status: 'AVAILABLE', notes: 'Call before dispatch' },
      });

      const batchInputs = [
        { code: 'B-017', weightKg: 120, grade: 'A', receivedAt: minutesFromNow(-360), equivalentQualityAgeDays: 5.8, remainingQualityWindowDays: 4.2, currentTemperatureC: 8 },
        { code: 'B-021', weightKg: 145, grade: 'A', receivedAt: minutesFromNow(-240), equivalentQualityAgeDays: 2.4, remainingQualityWindowDays: 7.6, currentTemperatureC: 2.8 },
        { code: 'B-024', weightKg: 110, grade: 'A', receivedAt: minutesFromNow(-120), equivalentQualityAgeDays: 0.9, remainingQualityWindowDays: 9.1, currentTemperatureC: 1.9 },
      ];
      const batches = new Map<string, { id: bigint }>();
      for (const input of batchInputs) {
        const batch = await transaction.batch.create({
          data: { ...input, userId: user.id, fishingTripId: fishingTrip.id, status: 'ACTIVE', qualityEstimateStartedAt: input.receivedAt },
        });
        batches.set(input.code, batch);
      }

      const sensorInputs = [
        { code: 'S-003', deviceUid: 'esp32-s-003', batchCode: 'B-017', temperatureC: 8 },
        { code: 'S-005', deviceUid: 'esp32-s-005', batchCode: 'B-021', temperatureC: 2.8 },
        { code: 'S-008', deviceUid: 'esp32-s-008', batchCode: 'B-024', temperatureC: 1.9 },
      ];
      for (const input of sensorInputs) {
        const sensor = await transaction.sensor.upsert({
          where: { userId_code: { userId: user.id, code: input.code } },
          update: { deviceUid: input.deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED', lastSeenAt: minutesFromNow(-1) },
          create: { userId: user.id, code: input.code, deviceUid: input.deviceUid, status: 'ASSIGNED', provisioningStatus: 'PROVISIONED', lastSeenAt: minutesFromNow(-1) },
        });
        const batch = batches.get(input.batchCode);
        if (!batch) throw new Error(`Missing seeded batch ${input.batchCode}`);
        await transaction.sensorSession.create({
          data: {
            sensorId: sensor.id,
            batchId: batch.id,
            startedAt: minutesFromNow(-120),
            status: 'ACTIVE',
            lastSyncedAt: minutesFromNow(-1),
            readings: { create: [
              { temperatureC: input.temperatureC - 0.2, measuredAt: minutesFromNow(-16), receivedAt: minutesFromNow(-15), readingUid: `seed-${input.code}-previous` },
              { temperatureC: input.temperatureC, measuredAt: minutesFromNow(-2), receivedAt: minutesFromNow(-1), readingUid: `seed-${input.code}-latest` },
            ] },
          },
        });
      }

      const excursion = await transaction.operationalEvent.create({
        data: {
          userId: user.id,
          batchId: batches.get('B-017')?.id,
          type: 'TEMPERATURE_EXCURSION',
          source: 'SYSTEM',
          rawMessage: 'B-017 reached 8.0°C for 42 minutes.',
          structuredData: { alert: { active: true, severity: 'CRITICAL', qualityStatus: 'WARNING', title: 'B-017 temperature excursion', description: '8.0°C for 42 min · 4.2 days remaining' } },
          occurredAt: minutesFromNow(-22),
        },
      });
      await transaction.operationalEvent.create({
        data: {
          userId: user.id,
          vehicleId: (await transaction.vehicle.findUniqueOrThrow({ where: { userId_code: { userId: user.id, code: 'TR-02' } } })).id,
          type: 'TRUCK_DELAY',
          source: 'WHATSAPP',
          rawMessage: 'TR-02 is delayed by 90 minutes.',
          structuredData: { alert: { active: true, severity: 'WARNING', title: 'TR-02 delayed', description: 'Expected availability moved by 90 minutes' } },
          occurredAt: minutesFromNow(-12),
        },
      });

      await transaction.plan.create({
        data: {
          userId: user.id,
          version: 3,
          status: 'ACTIVE',
          triggerEventId: excursion.id,
          reason: 'B-017 first: reduced quality margin after a temperature excursion.',
          approvedAt: minutesFromNow(-75),
          approvedById: user.id,
          steps: { create: [
            { sequence: 1, actionType: 'STORE', batchId: batches.get('B-017')!.id, coldStorageId: coldStorage.id, scheduledAt: minutesFromNow(-60), status: 'COMPLETED', completedAt: minutesFromNow(-54) },
            { sequence: 2, actionType: 'LOAD', batchId: batches.get('B-017')!.id, vehicleId: vehicle.id, scheduledAt: minutesFromNow(30), status: 'UPCOMING' },
            { sequence: 3, actionType: 'DISPATCH', batchId: batches.get('B-017')!.id, destinationId: destination.id, scheduledAt: minutesFromNow(60), status: 'UPCOMING' },
          ] },
        },
      });
    });
    console.log(`Seeded dashboard data for ${seededUser.email}`);
  } finally {
    await database.$disconnect();
  }
}

seed().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Seed failed');
  process.exitCode = 1;
});
