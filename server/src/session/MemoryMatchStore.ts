import { AggregateRecord, MatchStore, MatchStoreError, assertAggregate, assertNextRevision } from './MatchStore';
export class MemoryMatchStore<T extends AggregateRecord> implements MatchStore<T> {
  private readonly records = new Map<string, T>();
  constructor(initial: T[] = []) {
    for (const record of initial) {
      assertAggregate(record);
      if (this.records.has(record.sessionId)) throw new MatchStoreError('invalid-record', 'Duplicate seed session');
      this.records.set(record.sessionId, structuredClone(record));
    }
  }
  loadAll(): T[] { return structuredClone(Array.from(this.records.values())); }
  commit(next: T, expectedRevision: number): void {
    assertAggregate(next);
    assertNextRevision(next, expectedRevision, this.records.get(next.sessionId)?.revision ?? 0);
    this.records.set(next.sessionId, structuredClone(next));
  }
}
