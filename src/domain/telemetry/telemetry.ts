export type TelemetryReading = {
  sequenceNumber: number;
  measuredAt: Date;
  temperatureC: number;
};

export type TelemetryUpload = {
  sensorId: string;
  readings: TelemetryReading[];
};
