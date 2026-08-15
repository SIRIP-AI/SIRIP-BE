export const coldStorageStatuses = ['AVAILABLE', 'FULL', 'UNAVAILABLE'] as const;
export const vehicleStatuses = ['AVAILABLE', 'ASSIGNED', 'DELAYED', 'UNAVAILABLE'] as const;

export type ColdStorageStatus = typeof coldStorageStatuses[number];
export type VehicleStatus = typeof vehicleStatuses[number];

export type ColdStorage = {
  id: string;
  name: string;
  capacityKg: number;
  availableCapacityKg: number;
  status: ColdStorageStatus;
  updatedAt: string;
};

export type ColdStorageInput = Omit<ColdStorage, 'id' | 'updatedAt'>;

export type Vehicle = {
  id: string;
  code: string;
  capacityKg: number;
  status: VehicleStatus;
  delayMinutes: number;
  availableFrom: string | null;
  updatedAt: string;
};

export type VehicleInput = Omit<Vehicle, 'id' | 'updatedAt'>;
