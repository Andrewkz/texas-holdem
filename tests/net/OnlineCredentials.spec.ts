import { describe, expect, it } from 'vitest';

import {
  loadOnlineCredentials,
  parseOnlineCredentials,
  resolveServerUrl,
  saveOnlineCredentials,
} from '../../assets/scripts/net/OnlineCredentials';
import { DEFAULT_SERVER_URL, ONLINE_SESSION_STORAGE_KEY } from '../../assets/scripts/net/protocol';

class MemoryStorage {
  private readonly data = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  public removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('online credentials', () => {
  it('round-trips credentials through storage', () => {
    const storage = new MemoryStorage();
    const credentials = { roomCode: 'ABCD', token: 'tok', nickname: 'Alice', serverUrl: 'ws://example.test' };

    saveOnlineCredentials(storage, credentials);
    expect(storage.getItem(ONLINE_SESSION_STORAGE_KEY)).not.toBeNull();
    expect(loadOnlineCredentials(storage)).toEqual(credentials);
  });

  it('parses nothing from missing or corrupt data', () => {
    expect(parseOnlineCredentials(null)).toBeNull();
    expect(parseOnlineCredentials('not json')).toBeNull();
    expect(parseOnlineCredentials('{"roomCode":1}')).toBeNull();
  });

  it('resolves the server url with url-param > stored > default precedence', () => {
    const storage = new MemoryStorage();
    expect(resolveServerUrl(storage, '')).toBe(DEFAULT_SERVER_URL);

    saveOnlineCredentials(storage, { roomCode: 'ABCD', token: 't', nickname: 'A', serverUrl: 'ws://stored.test' });
    expect(resolveServerUrl(storage, '')).toBe('ws://stored.test');
    expect(resolveServerUrl(storage, '?server=wss://from-url.test')).toBe('wss://from-url.test');
  });
});
