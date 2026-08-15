export const coldStorageStatuses = ['AVAILABLE', 'FULL', 'UNAVAILABLE'] as const;
export const vehicleStatuses = ['AVAILABLE', 'ASSIGNED', 'DELAYED', 'UNAVAILABLE'] as const;
export const destinationStatuses = ['AVAILABLE', 'UNAVAILABLE'] as const;

export type ColdStorageStatus = typeof coldStorageStatuses[number];
export type VehicleStatus = typeof vehicleStatuses[number];
export type DestinationStatus = typeof destinationStatuses[number];

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
  restriction: string | null;
  availableFrom: string | null;
  updatedAt: string;
};

export type VehicleInput = Omit<Vehicle, 'id' | 'updatedAt'>;

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
