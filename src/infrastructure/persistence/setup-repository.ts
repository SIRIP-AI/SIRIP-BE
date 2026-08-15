import { Prisma } from '../../generated/prisma/client';
import type { ColdStorageInput, VehicleInput } from '../../domain/setup/resources';
import { ConflictError, NotFoundError } from '../../domain/setup/errors';
import type { Database } from './database';

function coldStorageResponse(resource: {
  id: bigint;
  name: string;
  capacityKg: number;
  availableCapacityKg: number;
  status: string;
  updatedAt: Date;
}) {
  return { ...resource, id: resource.id.toString(), updatedAt: resource.updatedAt.toISOString() };
}

function vehicleResponse(resource: {
  id: bigint;
  code: string;
  capacityKg: number;
  status: string;
  delayMinutes: number;
  availableFrom: Date | null;
  updatedAt: Date;
}) {
  return {
    ...resource,
    id: resource.id.toString(),
    availableFrom: resource.availableFrom?.toISOString() ?? null,
    updatedAt: resource.updatedAt.toISOString(),
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

export class SetupRepository {
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
    return (await this.database.vehicle.findMany({ orderBy: { code: 'asc' } })).map(vehicleResponse);
  }

  async createVehicle(input: VehicleInput) {
    try {
      return vehicleResponse(await this.database.vehicle.create({
        data: { ...input, availableFrom: input.availableFrom ? new Date(input.availableFrom) : null },
      }));
    } catch (error) {
      translateDatabaseError(error);
    }
  }

  async updateVehicle(id: bigint, input: VehicleInput) {
    try {
      return vehicleResponse(await this.database.vehicle.update({
        where: { id },
        data: { ...input, availableFrom: input.availableFrom ? new Date(input.availableFrom) : null },
      }));
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
}
