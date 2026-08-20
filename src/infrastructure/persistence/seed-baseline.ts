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

export async function resetSeedBaseline(transaction: Prisma.TransactionClient, userId: bigint) {
  const sessions = await transaction.sensorSession.findMany({
    where: { OR: [{ sensor: { userId } }, { batch: { userId } }] },
    select: { id: true, sensor: { select: { userId: true } }, batch: { select: { userId: true } } },
  });
  if (sessions.some((session) => isUnsafeSeedSession(userId, session))) {
    throw new ConflictError('Demo reset aborted because sensor data is linked to another account');
  }

  const sessionIds = sessions.map(({ id }) => id);
  const plans = await transaction.plan.deleteMany({ where: { userId } });
  const alerts = await transaction.operationalEvent.deleteMany({ where: { userId } });
  const messagingLinkTokens = await transaction.messagingLinkToken.deleteMany({ where: { userId } });
  const messagingConversations = await transaction.messagingConversation.deleteMany({ where: { userId } });
  const messagingConnections = await transaction.messagingConnection.deleteMany({ where: { userId } });
  const telemetry = await transaction.temperatureReading.deleteMany({ where: { sensorSessionId: { in: sessionIds } } });
  await transaction.sensorSession.deleteMany({ where: { id: { in: sessionIds } } });
  const sensors = await transaction.sensor.deleteMany({ where: { userId } });
  const batches = await transaction.batch.deleteMany({ where: { userId } });
  const fishingTrips = await transaction.fishingTrip.deleteMany({ where: { userId } });
  await transaction.coldStorage.deleteMany({ where: { userId } });
  await transaction.vehicle.deleteMany({ where: { userId } });
  await transaction.destination.deleteMany({ where: { userId } });

  await transaction.coldStorage.createMany({ data: [
    { userId, name: 'Cold Room 1', capacityKg: 1500, availableCapacityKg: 1500, operationalStatus: 'AVAILABLE' },
    { userId, name: 'Cold Room 2', capacityKg: 1000, availableCapacityKg: 1000, operationalStatus: 'AVAILABLE' },
  ] });
  await transaction.vehicle.createMany({ data: [
    { userId, code: 'TR-01', capacityKg: 1000, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('06:00'), availabilityEnd: time('16:00') },
    { userId, code: 'TR-02', capacityKg: 750, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: null, availabilityStart: time('08:00'), availabilityEnd: time('18:00') },
    { userId, code: 'TR-03', capacityKg: 500, operationalStatus: 'AVAILABLE', delayMinutes: 0, restriction: 'Short-haul deliveries only', availabilityStart: time('07:00'), availabilityEnd: time('15:00') },
  ] });
  await transaction.destination.createMany({ data: [
    { userId, name: 'Processor A', address: 'Tanjung Perak, Surabaya', travelMinutes: 45, receivingStart: time('08:00'), receivingEnd: time('16:00'), status: 'AVAILABLE', notes: 'Call 30 minutes before arrival' },
    { userId, name: 'Processor B', address: 'Sidoarjo', travelMinutes: 75, receivingStart: time('07:00'), receivingEnd: time('15:00'), status: 'AVAILABLE', notes: 'Grade confirmation required at receiving' },
    { userId, name: 'Processor C', address: 'Gresik', travelMinutes: 90, receivingStart: time('09:00'), receivingEnd: time('17:00'), status: 'AVAILABLE', notes: 'Use the cold-chain receiving dock' },
  ] });
  return {
    deleted: { fishingTrips: fishingTrips.count, batches: batches.count, plans: plans.count, sensors: sensors.count, telemetry: telemetry.count, alerts: alerts.count, messagingConnections: messagingConnections.count, messagingLinkTokens: messagingLinkTokens.count, messagingConversations: messagingConversations.count },
    restored: { resources: 8 },
  };
}
