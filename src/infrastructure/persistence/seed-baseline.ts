import type { Prisma } from '../../generated/prisma/client';
import { ConflictError } from '../../domain/errors';

export const seededUser = {
  name: 'Adi Rahman',
  email: 'adi.rahman@sirip.id',
  phone: '+6281234567890',
  password: 'SiripDemo2026!',
} as const;

const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

export function isUnsafeSeedSession(userId: bigint, session: { sensor: { userId: bigint | null }; batch: { userId: bigint | null } }) {
  return session.sensor.userId !== userId || session.batch.userId !== userId;
}

export async function resetSeedBaseline(transaction: Prisma.TransactionClient, userId: bigint, preserveMessagingConnection = false) {
  const sessions = await transaction.sensorSession.findMany({
    where: { OR: [{ sensor: { userId } }, { batch: { userId } }] },
    select: { id: true, sensor: { select: { userId: true } }, batch: { select: { userId: true } } },
  });
  if (sessions.some((session) => isUnsafeSeedSession(userId, session))) {
    throw new ConflictError('Reset demo dibatalkan karena data sensor terhubung ke akun lain');
  }

  const sessionIds = sessions.map(({ id }) => id);
  const plans = await transaction.plan.deleteMany({ where: { userId } });
  const alerts = await transaction.operationalEvent.deleteMany({ where: { userId } });
  const messagingLinkTokens = await transaction.messagingLinkToken.deleteMany({ where: { userId } });
  const messagingConversations = await transaction.messagingConversation.deleteMany({ where: { userId } });
  const messagingConnections = preserveMessagingConnection ? { count: 0 } : await transaction.messagingConnection.deleteMany({ where: { userId } });
  const telemetry = await transaction.temperatureReading.deleteMany({ where: { sensorSessionId: { in: sessionIds } } });
  await transaction.sensorSession.deleteMany({ where: { id: { in: sessionIds } } });
  const sensors = await transaction.sensor.deleteMany({ where: { userId } });
  const batches = await transaction.batch.deleteMany({ where: { userId } });
  const fishingTrips = await transaction.fishingTrip.deleteMany({ where: { userId } });
  await transaction.coldStorage.deleteMany({ where: { userId } });
  await transaction.vehicle.deleteMany({ where: { userId } });
  await transaction.destination.deleteMany({ where: { userId } });

  await transaction.coldStorage.createMany({ data: [
    { userId, name: 'CR-01', capacityKg: 800, availableCapacityKg: 600, operationalStatus: 'AVAILABLE' },
    { userId, name: 'CR-02', capacityKg: 400, availableCapacityKg: 220, operationalStatus: 'AVAILABLE' },
  ] });
  await transaction.vehicle.createMany({ data: [
    { userId, code: 'TR-01', capacityKg: 450, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('10:00'), availabilityEnd: time('14:00') },
    { userId, code: 'TR-02', capacityKg: 250, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('10:45'), availabilityEnd: time('15:00') },
    { userId, code: 'TR-03', capacityKg: 300, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('12:00'), availabilityEnd: time('16:00') },
  ] });
  await transaction.destination.createMany({ data: [
    { userId, name: 'Pengolah A', address: 'Tanjung Perak, Surabaya', travelMinutes: 60, receivingStart: time('11:30'), receivingEnd: time('14:30'), status: 'AVAILABLE', notes: 'Tujuan demo yang dipilih operator' },
    { userId, name: 'Pengolah B', address: 'Sidoarjo', travelMinutes: 45, receivingStart: time('10:00'), receivingEnd: time('13:00'), status: 'AVAILABLE', notes: 'Alternatif yang dikonfigurasi' },
    { userId, name: 'Pengolah C', address: 'Gresik', travelMinutes: 90, receivingStart: time('13:00'), receivingEnd: time('16:00'), status: 'UNAVAILABLE', notes: 'Tidak tersedia sementara' },
  ] });
  return {
    deleted: { fishingTrips: fishingTrips.count, batches: batches.count, plans: plans.count, sensors: sensors.count, telemetry: telemetry.count, alerts: alerts.count, messagingConnections: messagingConnections.count, messagingLinkTokens: messagingLinkTokens.count, messagingConversations: messagingConversations.count },
    restored: { resources: 8 },
  };
}
