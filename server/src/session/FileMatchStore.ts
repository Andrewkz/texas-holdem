import { constants, closeSync, chmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AggregateRecord, CommitHooks, CommitPoint, MatchStore, MatchStoreError, assertAggregate, assertNextRevision } from './MatchStore';

/** Synchronous atomic replacement, for a directory exclusively owned by one server process. */
export class FileMatchStore<T extends AggregateRecord> implements MatchStore<T> {
  private readonly directory: string;
  constructor(directory: string, private readonly validate: (raw: unknown) => T, private readonly hooks: CommitHooks<T> = {}) {
    this.directory = resolve(directory);
    this.assertDirectoryPath();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.assertDirectoryPath(); chmodSync(this.directory, 0o700);
  }
  private assertDirectoryPath(): void {
    let path = this.directory;
    for (;;) {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MatchStoreError('unsafe-path', 'Data directory ancestry must contain only real directories');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = dirname(path); if (parent === path) return; path = parent;
    }
  }
  private readRecord(path: string, sessionId: string): T | undefined {
    let fd: number;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new MatchStoreError('unsafe-path', 'Committed records must be regular files');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new MatchStoreError('unsafe-path', 'Committed record is not a regular file');
      const raw: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      assertAggregate(raw);
      const record = this.validate(structuredClone(raw)); assertAggregate(record);
      if (record.sessionId !== sessionId || (raw as AggregateRecord).sessionId !== sessionId || record.revision !== (raw as AggregateRecord).revision) throw new Error('Record identity does not match its committed filename');
      return structuredClone(record);
    } catch (error) {
      if (error instanceof MatchStoreError && error.code === 'unsafe-path') throw error;
      throw new MatchStoreError('corrupt-record', `Invalid committed aggregate ${sessionId}`, { cause: error });
    } finally { closeSync(fd); }
  }
  loadAll(): T[] {
    this.assertDirectoryPath();
    const result: T[] = [];
    for (const name of readdirSync(this.directory).sort()) {
      const path = join(this.directory, name);
      if (lstatSync(path).isSymbolicLink()) throw new MatchStoreError('unsafe-path', 'Data directory cannot contain symbolic links');
      // Exclusive temporary leftovers are uncommitted and are never recovery input.
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -5);
      try { assertAggregate({ sessionId, revision: 1 }); }
      catch (error) { throw new MatchStoreError('corrupt-record', 'Invalid committed filename', { cause: error }); }
      const record = this.readRecord(path, sessionId);
      if (record) result.push(record);
    }
    return result;
  }
  commit(next: T, expectedRevision: number): void {
    this.assertDirectoryPath(); assertAggregate(next);
    const record = this.validate(structuredClone(next)); assertAggregate(record);
    if (record.sessionId !== next.sessionId || record.revision !== next.revision) throw new MatchStoreError('invalid-record', 'Validator cannot rewrite aggregate identity');
    const target = join(this.directory, `${record.sessionId}.json`);
    const current = this.readRecord(target, record.sessionId);
    assertNextRevision(record, expectedRevision, current?.revision ?? 0);
    // Serialization happens before any disk mutation, so unsupported values cannot half-write.
    const serialized = JSON.stringify(record);
    const temp = join(this.directory, `.${record.sessionId}.${randomUUID()}.tmp`);
    const barrier = (point: CommitPoint) => this.hooks.at?.(point, structuredClone(record));
    let fd: number | undefined; let renamed = false; let created = false;
    try {
      barrier('before-write');
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      writeFileSync(fd, serialized, 'utf8'); fsyncSync(fd); barrier('after-file-sync');
      closeSync(fd); fd = undefined;
      renameSync(temp, target); renamed = true; barrier('after-rename');
      const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      barrier('after-directory-sync');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created && !renamed) { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    }
  }
}
