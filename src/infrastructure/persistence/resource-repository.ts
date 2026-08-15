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
  return { ...resource, id: resource.id.toString(), status, updatedAt: resource.updatedAt.toISOString() };
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
    ...resource,
    id: resource.id.toString(),
    status,
    availabilityStart: resource.availabilityStart?.toISOString().slice(11, 16) ?? null,
    availabilityEnd: resource.availabilityEnd?.toISOString().slice(11, 16) ?? null,
    updatedAt: resource.updatedAt.toISOString(),
    planSteps: undefined,
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
    ...resource,
    id: resource.id.toString(),
    receivingStart: resource.receivingStart.toISOString().slice(11, 16),
    receivingEnd: resource.receivingEnd.toISOString().slice(11, 16),
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
  return {
    id: resource.id.toString(),
    code: resource.code,
    deviceUid: resource.deviceUid,
    status: resource.status,
    provisioningStatus: resource.provisioningStatus,
    connectivityStatus: resource.status === 'ERROR' ? 'ERROR' : resource.status === 'OFFLINE' ? 'OFFLINE' : resource.lastSeenAt ? 'ONLINE' : 'NEVER_CONNECTED',
    lastSeenAt: resource.lastSeenAt?.toISOString() ?? null,
    createdAt: resource.createdAt.toISOString(),
    assignment: session ? { batchCode: session.batch.code, lastSyncedAt: session.lastSyncedAt?.toISOString() ?? null } : null,
  };
}

const sensorInclude = {
  sessions: {
    where: { status: 'ACTIVE' as const },
    select: { batch: { select: { code: true } }, lastSyncedAt: true },
    take: 1,
  },
};

const vehicleInclude = {
  planSteps: {
    where: { status: 'UPCOMING' as const, plan: { status: 'ACTIVE' as const } },
    select: { id: true },
    take: 1,
  },
};

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

  async listColdStorages() {
    return (await this.database.coldStorage.findMany({ orderBy: { name: 'asc' } })).map(coldStorageResponse);
  }

  async createColdStorage(input: ColdStorageInput) {
    try {
      return coldStorageResponse(await this.database.coldStorage.create({ data: input }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateColdStorage(id: bigint, input: ColdStorageInput) {
    try {
      const existing = await this.database.coldStorage.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError('Resource');
      if (existing.availableCapacityKg === 0 && existing.operationalStatus !== input.operationalStatus) {
        throw new ConflictError('Operational status cannot be changed while cold storage is full');
      }
      return coldStorageResponse(await this.database.coldStorage.update({ where: { id }, data: input }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteColdStorage(id: bigint) {
    try {
      await this.database.coldStorage.delete({ where: { id } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listVehicles() {
    return (await this.database.vehicle.findMany({ orderBy: { code: 'asc' }, include: vehicleInclude })).map(vehicleResponse);
  }

  async createVehicle(input: VehicleInput) {
    try {
      return vehicleResponse(await this.database.vehicle.create({ data: vehicleData(input), include: vehicleInclude }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateVehicle(id: bigint, input: VehicleInput) {
    try {
      return vehicleResponse(await this.database.vehicle.update({ where: { id }, data: vehicleData(input), include: vehicleInclude }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteVehicle(id: bigint) {
    try {
      await this.database.vehicle.delete({ where: { id } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listDestinations() {
    return (await this.database.destination.findMany({ orderBy: { name: 'asc' } })).map(destinationResponse);
  }

  async createDestination(input: DestinationInput) {
    try {
      return destinationResponse(await this.database.destination.create({ data: destinationData(input) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateDestination(id: bigint, input: DestinationInput) {
    try {
      return destinationResponse(await this.database.destination.update({ where: { id }, data: destinationData(input) }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteDestination(id: bigint) {
    try {
      await this.database.destination.delete({ where: { id } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listSensors() {
    return (await this.database.sensor.findMany({ orderBy: { code: 'asc' }, include: sensorInclude })).map(sensorResponse);
  }

  async createSensor(input: SensorInput) {
    try {
      return sensorResponse(await this.database.sensor.create({ data: { ...input, status: 'AVAILABLE' }, include: sensorInclude }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateSensor(id: bigint, input: SensorInput) {
    try {
      return sensorResponse(await this.database.sensor.update({ where: { id }, data: input, include: sensorInclude }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async deleteSensor(id: bigint) {
    try {
      await this.database.sensor.delete({ where: { id } });
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async listSensorAssignmentOptions() {
    return this.database.batch.findMany({
      where: { status: { in: ['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'] }, sensorSessions: { none: { status: 'ACTIVE' } } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, weightKg: true, grade: true },
    }).then((batches) => batches.map((batch) => ({ ...batch, id: batch.id.toString() })));
  }

  async assignSensor(id: bigint, input: SensorAssignmentInput) {
    try {
      const sensor = await this.database.sensor.findUnique({ where: { id }, include: sensorInclude });
      if (!sensor) throw new NotFoundError('Sensor');
      if (sensor.provisioningStatus !== 'PROVISIONED') throw new ConflictError('Provision the sensor before assigning it');
      if (sensor.sessions.length) throw new ConflictError('Sensor is already assigned');
      const batch = await this.database.batch.findUnique({ where: { code: input.batchCode } });
      if (!batch || !['MONITORING', 'ACTIVE', 'INSPECTION_HOLD'].includes(batch.status)) throw new NotFoundError('Assignable batch');
      await this.database.$transaction([
        this.database.sensorSession.create({ data: { sensorId: id, batchId: batch.id, startedAt: new Date(), status: 'ACTIVE' } }),
        this.database.sensor.update({ where: { id }, data: { status: 'ASSIGNED' } }),
      ]);
      return sensorResponse(await this.database.sensor.findUniqueOrThrow({ where: { id }, include: sensorInclude }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async unassignSensor(id: bigint) {
    try {
      const sensor = await this.database.sensor.findUnique({ where: { id }, include: sensorInclude });
      if (!sensor) throw new NotFoundError('Sensor');
      const session = await this.database.sensorSession.findFirst({ where: { sensorId: id, status: 'ACTIVE' } });
      if (!session) throw new ConflictError('Sensor is not assigned');
      await this.database.$transaction([
        this.database.sensorSession.update({ where: { id: session.id }, data: { status: 'COMPLETED', endedAt: new Date() } }),
        this.database.sensor.update({ where: { id }, data: { status: 'AVAILABLE' } }),
      ]);
      return sensorResponse(await this.database.sensor.findUniqueOrThrow({ where: { id }, include: sensorInclude }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async sensorDiagnostics(id: bigint) {
    const sensor = await this.database.sensor.findUnique({
      where: { id },
      include: {
        sessions: {
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
