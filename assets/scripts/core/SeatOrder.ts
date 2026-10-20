/** Physical clockwise order, starting at the top seat; shared by solo and online mappings. */
export const CLOCKWISE_SEAT_IDS = ['ai-1', 'ai-3', 'ai-4', 'player', 'ai-5', 'ai-2'] as const;

export function clockwiseSeatIdsFrom(startId: string): readonly string[] {
  const start = CLOCKWISE_SEAT_IDS.findIndex((id) => id === startId);
  if (start < 0) throw new Error(`Unknown seat: ${startId}`);
  return [...CLOCKWISE_SEAT_IDS.slice(start), ...CLOCKWISE_SEAT_IDS.slice(0, start)];
}
