export const batchFilters = ['active', 'at-risk', 'closed'] as const;
export type BatchFilter = typeof batchFilters[number];

export type BatchInput = {
  code: string;
  fishingTripId: bigint;
  weightKg: number;
  grade: string;
  receivedAt: string;
};
