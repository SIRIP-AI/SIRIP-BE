export const resourceOperationalStatuses = ['AVAILABLE', 'UNAVAILABLE'] as const;
export const coldStorageStatuses = ['AVAILABLE', 'FULL', 'UNAVAILABLE'] as const;
export const vehicleStatuses = ['AVAILABLE', 'ASSIGNED', 'UNAVAILABLE'] as const;
export const destinationStatuses = ['AVAILABLE', 'UNAVAILABLE'] as const;

export type ResourceOperationalStatus = typeof resourceOperationalStatuses[number];
export type ColdStorageStatus = typeof coldStorageStatuses[number];
export type VehicleStatus = typeof vehicleStatuses[number];
export type DestinationStatus = typeof destinationStatuses[number];

export type ColdStorage = {
  id: string;
  name: string;
  capacityKg: number;
  availableCapacityKg: number;
  operationalStatus: ResourceOperationalStatus;
  status: ColdStorageStatus;
  updatedAt: string;
};

export type ColdStorageInput = Pick<ColdStorage, 'name' | 'capacityKg' | 'availableCapacityKg' | 'operationalStatus'>;

export type Vehicle = {
  id: string;
  code: string;
  capacityKg: number;
  operationalStatus: ResourceOperationalStatus;
  status: VehicleStatus;
  delayMinutes: number;
  restriction: string | null;
  availabilityStart: string | null;
  availabilityEnd: string | null;
  updatedAt: string;
};

export type VehicleInput = Pick<Vehicle, 'code' | 'capacityKg' | 'operationalStatus' | 'restriction' | 'availabilityStart' | 'availabilityEnd'>;

export type Destination = {
  id: string;
  name: string;
  address: string;
  travelMinutes: number;
  receivingStart: string;
  receivingEnd: string;
  status: DestinationStatus;
  notes: string | null;
  updatedAt: string;
};

export type DestinationInput = Omit<Destination, 'id' | 'updatedAt'>;

export const sensorProvisioningStatuses = ['PENDING', 'PROVISIONED'] as const;
export type SensorProvisioningStatus = typeof sensorProvisioningStatuses[number];

export type SensorInput = {
  code: string;
  deviceUid: string;
  provisioningStatus: SensorProvisioningStatus;
};

export type SensorAssignmentInput = {
  batchCode: string;
};
