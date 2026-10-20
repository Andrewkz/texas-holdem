export interface AggregateRecord { sessionId: string; revision: number }
/** One process owns a data directory. This API does not coordinate concurrent writers. */
export interface MatchStore<T extends AggregateRecord> {
  loadAll(): T[];
  commit(next: T, expectedRevision: number): void;
}
export type CommitPoint = 'before-write' | 'after-file-sync' | 'after-rename' | 'after-directory-sync';
export interface CommitHooks<T extends AggregateRecord> { at?: (point: CommitPoint, record: T) => void }
export class MatchStoreError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'MatchStoreError'; }
}
export function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new MatchStoreError('unsafe-path', 'Session ID must be a safe basename');
}
export function assertAggregate(value: unknown): asserts value is AggregateRecord {
  if (!value || typeof value !== 'object') throw new MatchStoreError('invalid-record', 'Expected an aggregate record');
  const r = value as AggregateRecord; assertSessionId(r.sessionId);
  if (!Number.isSafeInteger(r.revision) || r.revision < 1) throw new MatchStoreError('invalid-record', 'Revision must be a positive safe integer');
}
export function assertNextRevision(next: AggregateRecord, expectedRevision: number, actualRevision: number): void {
  assertAggregate(next);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new MatchStoreError('invalid-record', 'Expected revision must be a nonnegative safe integer');
  if (actualRevision !== expectedRevision) throw new MatchStoreError('revision-conflict', 'Aggregate revision has changed');
  if (!Number.isSafeInteger(expectedRevision + 1) || next.revision !== expectedRevision + 1) throw new MatchStoreError('invalid-record', 'Next revision must be expected revision plus one');
}
