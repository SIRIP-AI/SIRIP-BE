import { Prisma } from '../../generated/prisma/client';
import type { ColdStorageInput, DestinationInput, SensorAssignmentInput, SensorInput, VehicleInput } from '../../domain/resources';
import { ConflictError, NotFoundError } from '../../domain/errors';
import type { Database } from './database';

function coldStorageResponse(resource: {
  id: bigint;
  name: string;
  capacityKg: number;
  availableCapacityKg: number;
  operationalStatus: string;
  updatedAt: Date;
}) {
  const status = resource.operationalStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : resource.availableCapacityKg === 0 ? 'FULL' : 'AVAILABLE';
  return {
    id: resource.id.toString(),
    name: resource.name,
    capacityKg: resource.capacityKg,
    availableCapacityKg: resource.availableCapacityKg,
    operationalStatus: resource.operationalStatus,
    status,
    updatedAt: resource.updatedAt.toISOString(),
  };
}

function vehicleResponse(resource: {
  id: bigint;
  code: string;
  capacityKg: number;
  operationalStatus: string;
  delayMinutes: number;
  restriction: string | null;
  availabilityStart: Date | null;
  availabilityEnd: Date | null;
  updatedAt: Date;
  planSteps: Array<{ id: bigint }>;
}) {
  const status = resource.operationalStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : resource.planSteps.length ? 'ASSIGNED' : 'AVAILABLE';
  return {
    id: resource.id.toString(),
    code: resource.code,
    capacityKg: resource.capacityKg,
    operationalStatus: resource.operationalStatus,
    status,
    delayMinutes: resource.delayMinutes,
    restriction: resource.restriction,
    availabilityStart: resource.availabilityStart?.toISOString().slice(11, 16) ?? null,
    availabilityEnd: resource.availabilityEnd?.toISOString().slice(11, 16) ?? null,
    updatedAt: resource.updatedAt.toISOString(),
  };
}

function destinationResponse(resource: {
  id: bigint;
  name: string;
  address: string;
  travelMinutes: number;
  receivingStart: Date;
  receivingEnd: Date;
  status: string;
  notes: string | null;
  updatedAt: Date;
}) {
  return {
    id: resource.id.toString(),
    name: resource.name,
    address: resource.address,
    travelMinutes: resource.travelMinutes,
    receivingStart: resource.receivingStart.toISOString().slice(11, 16),
    receivingEnd: resource.receivingEnd.toISOString().slice(11, 16),
    status: resource.status,
    notes: resource.notes,
    updatedAt: resource.updatedAt.toISOString(),
  };
}

function destinationData(input: DestinationInput) {
  return {
    ...input,
    receivingStart: new Date(`1970-01-01T${input.receivingStart}:00.000Z`),
    receivingEnd: new Date(`1970-01-01T${input.receivingEnd}:00.000Z`),
  };
}

function vehicleData(input: VehicleInput) {
  return {
    ...input,
    availabilityStart: input.availabilityStart ? new Date(`1970-01-01T${input.availabilityStart}:00.000Z`) : null,
    availabilityEnd: input.availabilityEnd ? new Date(`1970-01-01T${input.availabilityEnd}:00.000Z`) : null,
  };
}

function sensorResponse(resource: {
  id: bigint;
  code: string;
  deviceUid: string;
  status: string;
  provisioningStatus: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  sessions: Array<{ batch: { code: string }; lastSyncedAt: Date | null }>;
}) {
  const session = resource.sessions[0];
  const recentlySeen = resource.lastSeenAt && Date.now() - resource.lastSeenAt.getTime() <= 20 * 60 * 1000;
  return {
    id: resource.id.toString(),
    code: resource.code,
    deviceUid: resource.deviceUid,
    status: resource.status,
    provisioningStatus: resource.provisioningStatus,
    connectivityStatus: resource.status === 'ERROR' ? 'ERROR' : resource.status === 'OFFLINE' || (resource.lastSeenAt && !recentlySeen) ? 'OFFLINE' : recentlySeen ? 'ONLINE' : 'NEVER_CONNECTED',
    lastSeenAt: resource.lastSeenAt?.toISOString() ?? null,
    createdAt: resource.createdAt.toISOString(),
    assignment: session ? { batchCode: session.batch.code, lastSyncedAt: session.lastSyncedAt?.toISOString() ?? null } : null,
  };
}

function sensorInclude(userId: bigint) {
  return {
    sessions: {
      where: { status: 'ACTIVE' as const, batch: { userId, deletedAt: null } },
      select: { batch: { select: { code: true } }, lastSyncedAt: true },
      take: 1,
    },
  };
}

function vehicleInclude(userId: bigint) {
  return {
    planSteps: {
      where: { status: 'UPCOMING' as const, batch: { deletedAt: null }, plan: { userId, status: 'ACTIVE' as const } },
      select: { id: true },
      take: 1,
    },
  };
}

function translateDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new ConflictError('A resource with that name or code already exists');
    if (error.code === 'P2003') throw new ConflictError('This resource is used by operational history and cannot be deleted');
    if (error.code === 'P2025') throw new NotFoundError('Resource');
  }
  throw error;
}

export class ResourceRepository {
  constructor(private readonly database: Database) {}

  async listColdStorages(userId: bigint) {
    return (await this.database.coldStorage.findMany({ where: { userId }, orderBy: { name: 'asc' } })).map(coldStorageResponse);
  }

  async createColdStorage(userId: bigint, input: ColdStorageInput) {
    try {
      return coldStorageResponse(await this.database.coldStorage.create({ data: { ...input, userId } }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateColdStorage(userId: bigint, id: bigint, input: ColdStorageInput) {
    try {
      const existing = await this.database.coldStorage.findFirst({ where: { id, userId } });
      if (!existing) throw new NotFoundError('Resource');
      if (existing.availableCapacityKg === 0 && existing.operationalStatus !== input.operationalStatus) {
        throw new ConflictError('Operational status cannot be changed while cold storage is full');
      }
      return coldStorageResponse(await this.database.coldStorage.update({ where: { id, userId }, data: input }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteColdStorage(userId: bigint, id: bigint) {
    try {
      await this.database.coldStorage.delete({ where: { id, userId } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listVehicles(userId: bigint) {
    return (await this.database.vehicle.findMany({ where: { userId }, orderBy: { code: 'asc' }, include: vehicleInclude(userId) })).map(vehicleResponse);
  }

  async createVehicle(userId: bigint, input: VehicleInput) {
    try {
      return vehicleResponse(await this.database.vehicle.create({ data: { ...vehicleData(input), userId }, include: vehicleInclude(userId) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateVehicle(userId: bigint, id: bigint, input: VehicleInput) {
    try {
      return vehicleResponse(await this.database.vehicle.update({ where: { id, userId }, data: vehicleData(input), include: vehicleInclude(userId) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteVehicle(userId: bigint, id: bigint) {
    try {
      await this.database.vehicle.delete({ where: { id, userId } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listDestinations(userId: bigint) {
    return (await this.database.destination.findMany({ where: { userId }, orderBy: { name: 'asc' } })).map(destinationResponse);
  }

  async createDestination(userId: bigint, input: DestinationInput) {
    try {
      return destinationResponse(await this.database.destination.create({ data: { ...destinationData(input), userId } }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateDestination(userId: bigint, id: bigint, input: DestinationInput) {
    try {
      return destinationResponse(await this.database.destination.update({ where: { id, userId }, data: destinationData(input) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteDestination(userId: bigint, id: bigint) {
    try {
      await this.database.destination.delete({ where: { id, userId } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listSensors(userId: bigint) {
    return (await this.database.sensor.findMany({ where: { userId, deletedAt: null }, orderBy: { code: 'asc' }, include: sensorInclude(userId) })).map(sensorResponse);
  }

  async sensorReadings(userId: bigint, id: bigint) {
    const sensor = await this.database.sensor.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
    if (!sensor) throw new NotFoundError('Sensor');
    return this.database.temperatureReading.findMany({
      where: { sensorSession: { sensorId: id } },
      orderBy: [{ measuredAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { temperatureC: true, measuredAt: true, receivedAt: true },
    }).then((readings) => readings.reverse().map((reading) => ({
      temperatureC: reading.temperatureC,
      measuredAt: reading.measuredAt.toISOString(),
      receivedAt: reading.receivedAt.toISOString(),
    })));
  }

  async createSensor(userId: bigint, input: SensorInput) {
    try {
      const existing = await this.database.sensor.findUnique({ where: { deviceUid: input.deviceUid }, include: sensorInclude(userId) });
      if (existing) {
        if (existing.userId === userId && existing.code === input.code && input.provisioningStatus === 'PROVISIONED') {
          if (!existing.deletedAt) return sensorResponse(existing);
          return sensorResponse(await this.database.sensor.update({
            where: { id: existing.id },
            data: { ...input, status: 'AVAILABLE', lastSeenAt: new Date(), deletedAt: null },
            include: sensorInclude(userId),
          }));
        }
        throw new ConflictError('A resource with that name or code already exists');
      }
      return sensorResponse(await this.database.sensor.create({
        data: { ...input, userId, status: 'AVAILABLE', lastSeenAt: input.provisioningStatus === 'PROVISIONED' ? new Date() : null },
        include: sensorInclude(userId),
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && input.provisioningStatus === 'PROVISIONED') {
        const existing = await this.database.sensor.findUnique({ where: { deviceUid: input.deviceUid }, include: sensorInclude(userId) });
        if (existing?.userId === userId && existing.code === input.code) return sensorResponse(existing);
      }
      translateDatabaseError(error);
    }
  }

  async updateSensor(userId: bigint, id: bigint, input: SensorInput) {
    try {
      return sensorResponse(await this.database.sensor.update({ where: { id, userId, deletedAt: null }, data: input, include: sensorInclude(userId) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteSensor(userId: bigint, id: bigint) {
    const sensor = await this.database.sensor.findFirst({ where: { id, userId, deletedAt: null }, include: { sessions: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 } } });
    if (!sensor) throw new NotFoundError('Resource');
    if (sensor.sessions.length) throw new ConflictError('Unassign the sensor before deleting it');
    await this.database.sensor.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async listSensorAssignmentOptions(userId: bigint) {
    return this.database.batch.findMany({
      where: { userId, deletedAt: null, status: { in: ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] }, sensorSessions: { none: { status: 'ACTIVE' } } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, weightKg: true, grade: true },
    }).then((batches) => batches.map((batch) => ({ ...batch, id: batch.id.toString() })));
  }

  async assignSensor(userId: bigint, id: bigint, input: SensorAssignmentInput) {
    try {
      const sensor = await this.database.sensor.findFirst({ where: { id, userId, deletedAt: null }, include: sensorInclude(userId) });
      if (!sensor) throw new NotFoundError('Sensor');
      if (sensor.provisioningStatus !== 'PROVISIONED') throw new ConflictError('Provision the sensor before assigning it');
      if (sensor.sessions.length) throw new ConflictError('Sensor is already assigned');
      const batch = await this.database.batch.findFirst({
        where: { userId, code: input.batchCode, deletedAt: null, status: { in: ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] }, sensorSessions: { none: { status: 'ACTIVE' } } },
      });
      if (!batch) throw new NotFoundError('Assignable batch');
      await this.database.$transaction([
        this.database.sensorSession.create({ data: { sensorId: id, batchId: batch.id, startedAt: new Date(), status: 'ACTIVE' } }),
        this.database.sensor.update({ where: { id, userId, deletedAt: null }, data: { status: 'ASSIGNED' } }),
      ]);
      return sensorResponse(await this.database.sensor.findFirstOrThrow({ where: { id, userId, deletedAt: null }, include: sensorInclude(userId) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async unassignSensor(userId: bigint, id: bigint) {
    try {
      const sensor = await this.database.sensor.findFirst({ where: { id, userId, deletedAt: null }, include: sensorInclude(userId) });
      if (!sensor) throw new NotFoundError('Sensor');
      const session = await this.database.sensorSession.findFirst({ where: { sensorId: id, status: 'ACTIVE', batch: { userId, deletedAt: null } } });
      if (!session) throw new ConflictError('Sensor is not assigned');
      await this.database.$transaction([
        this.database.sensorSession.update({ where: { id: session.id }, data: { status: 'COMPLETED', endedAt: new Date() } }),
        this.database.sensor.update({ where: { id, userId, deletedAt: null }, data: { status: 'AVAILABLE' } }),
      ]);
      return sensorResponse(await this.database.sensor.findFirstOrThrow({ where: { id, userId, deletedAt: null }, include: sensorInclude(userId) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async setupReadiness(userId: bigint) {
    const [coldStorages, vehicles, destinations, sensors] = await Promise.all([
      this.database.coldStorage.count({ where: { userId } }),
      this.database.vehicle.count({ where: { userId } }),
      this.database.destination.count({ where: { userId } }),
      this.database.sensor.count({ where: { userId, deletedAt: null } }),
    ]);
    const steps = [
      { key: 'coldStorages', label: 'Configure cold storage', complete: coldStorages > 0, count: coldStorages },
      { key: 'vehicles', label: 'Configure trucks', complete: vehicles > 0, count: vehicles },
      { key: 'destinations', label: 'Configure destinations', complete: destinations > 0, count: destinations },
      { key: 'sensors', label: 'Configure sensors', complete: sensors > 0, count: sensors },
    ];
    return { ready: steps.every((step) => step.complete), completedSteps: steps.filter((step) => step.complete).length, totalSteps: steps.length, steps };
  }

  async sensorDiagnostics(userId: bigint, id: bigint) {
    const sensor = await this.database.sensor.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        sessions: {
          where: { batch: { userId, deletedAt: null } },
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: { batch: { select: { code: true } }, readings: { orderBy: { measuredAt: 'desc' }, take: 1 } },
        },
      },
    });
    if (!sensor) throw new NotFoundError('Sensor');
    const session = sensor.sessions[0];
    const reading = session?.readings[0];
    return {
      sensor: sensorResponse({ ...sensor, sessions: session?.status === 'ACTIVE' ? [session] : [] }),
      latestReading: reading ? { temperatureC: reading.temperatureC, measuredAt: reading.measuredAt.toISOString(), receivedAt: reading.receivedAt.toISOString() } : null,
      lastSyncedAt: session?.lastSyncedAt?.toISOString() ?? null,
      sessionStatus: session?.status ?? null,
    };
  }
}
