export class TelemetryBlocklist {
  private readonly deviceUids = new Set<string>();

  block(deviceUid: string) {
    this.deviceUids.add(deviceUid);
  }

  unblock(deviceUid: string) {
    this.deviceUids.delete(deviceUid);
  }

  has(deviceUid: string) {
    return this.deviceUids.has(deviceUid);
  }
}
