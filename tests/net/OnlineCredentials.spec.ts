import { describe, expect, it } from 'vitest';

import {
  clearMatchingOnlineCredentials,
  loadOnlineCredentials,
  normalizeServerUrl,
  resolveInvitationServerUrl,
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

  it.each([
    ['http://poker.example.test', 'ws://poker.example.test/ws'],
    ['https://poker.example.test', 'wss://poker.example.test/ws'],
    ['https://poker.example.test:8443/game/?invite=ABCD', 'wss://poker.example.test:8443/ws'],
    ['http://192.0.2.20:8080', 'ws://192.0.2.20:8080/ws'],
  ])('defaults to the same-origin websocket for %s', (pageUrl, expected) => {
    expect(resolveServerUrl(new MemoryStorage(), '', pageUrl)).toBe(expected);
  });

  it('keeps url-param and stored preferences ahead of same-origin defaults', () => {
    const storage = new MemoryStorage();
    const pageOrigin = 'https://poker.example.test';

    expect(resolveServerUrl(storage, '?server=ws%3A%2F%2Ffrom-url.test%3A2567', pageOrigin)).toBe('ws://from-url.test:2567');
    saveOnlineCredentials(storage, { roomCode: 'ABCD', token: 't', nickname: 'A', serverUrl: 'wss://stored.test' });
    expect(resolveServerUrl(storage, '', pageOrigin)).toBe('wss://stored.test');
    expect(resolveServerUrl(storage, '?server=wss://from-url.test', pageOrigin)).toBe('wss://from-url.test');
  });

  it.each([
    'http://localhost:7456',
    'https://localhost',
    'http://127.0.0.1:7456',
    'http://[::1]:7456',
    '',
    'not a valid url',
    'file:///games/index.html',
    'ws://poker.example.test',
  ])('preserves the local development default for %s', (pageOrigin) => {
    expect(resolveServerUrl(new MemoryStorage(), '', pageOrigin)).toBe(DEFAULT_SERVER_URL);
  });
});


describe('invitation endpoint selection', () => {
  it('ignores stored identity and arbitrary server overrides for any explicit invitation', () => {
    const storage = new MemoryStorage();
    saveOnlineCredentials(storage, { roomCode: 'AB23', token: 'private', nickname: 'Alice', serverUrl: 'wss://other.test/ws' });
    for (const search of ['?room=AB23&server=wss://override.test/ws', '?room=&server=wss://override.test/ws']) {
      expect(resolveServerUrl(storage, search, 'https://example.test/poker/')).toBe('wss://example.test/ws');
    }
  });

  it.each([
    ['https://example.test/poker/?server=wss://other.test/ws', 'wss://example.test/ws'],
    ['http://192.0.2.20:8080/poker/', 'ws://192.0.2.20:8080/ws'],
    ['http://localhost:7456/', 'ws://localhost:2567'],
    ['http://127.0.0.1:7456/', 'ws://localhost:2567'],
    ['http://[::1]:7456/', 'ws://localhost:2567'],
  ])('uses the deploy target for %s', (pageUrl, target) => {
    expect(resolveInvitationServerUrl(pageUrl)).toBe(target);
  });

  it.each(['', 'not a url', 'file:///game/index.html', 'ws://example.test/', 'https://alice:private@example.test/'])('rejects an unsupported invitation deployment %s', (pageUrl) => {
    expect(() => resolveInvitationServerUrl(pageUrl)).toThrow();
  });

  it('normalizes full websocket endpoints without discarding meaningful fields', () => {
    expect(normalizeServerUrl(' WSS://EXAMPLE.test:443/ws?b=2&a=1 ')).toBe('wss://example.test/ws?a=1&b=2');
    expect(normalizeServerUrl('ws://example.test:80')).toBe('ws://example.test/');
    expect(normalizeServerUrl('wss://example.test/ws?a=1&a=2')).not.toBe(normalizeServerUrl('wss://example.test/ws?a=2&a=1'));
    for (const url of ['https://example.test/ws', 'ws://alice:private@example.test/ws', 'ws://example.test/ws#fragment', 'invalid']) {
      expect(normalizeServerUrl(url)).toBeNull();
    }
  });
});

describe('matching credential cleanup', () => {
  const original = { roomCode: 'AB23', token: 'old-token', nickname: 'Alice', serverUrl: 'wss://example.test/ws' };

  it('clears the identity that was explicitly abandoned', () => {
    const storage = new MemoryStorage();
    saveOnlineCredentials(storage, original);
    clearMatchingOnlineCredentials(storage, original);
    expect(loadOnlineCredentials(storage)).toBeNull();
  });

  it('preserves a replacement saved by another connection or tab', () => {
    const storage = new MemoryStorage();
    for (const replacement of [
      { ...original, token: 'new-token' },
      { ...original, roomCode: 'CD45' },
      { ...original, nickname: 'New name' },
      { ...original, serverUrl: 'wss://other.test/ws' },
    ]) {
      saveOnlineCredentials(storage, replacement);
      clearMatchingOnlineCredentials(storage, original);
      expect(loadOnlineCredentials(storage)).toEqual(replacement);
    }
  });
});

describe('v3 stable session proofs', () => {
  it('retains separate sessions and disables automatic seat recovery after explicit leave', async () => {
    const { deactivateOnlineCredentials, findOnlineCredentials } = await import('../../assets/scripts/net/OnlineCredentials');
    const storage=new MemoryStorage();
    const first={roomCode:'AB23',sessionId:'s1',playerId:'p1',token:'proof1',nickname:'A',serverUrl:'wss://example.test/ws',autoResume:true};
    const second={...first,sessionId:'s2',token:'proof2'};
    saveOnlineCredentials(storage,first);saveOnlineCredentials(storage,second);
    deactivateOnlineCredentials(storage,second);
    expect(loadOnlineCredentials(storage)).toBeNull();
    expect(findOnlineCredentials(storage,first.serverUrl,'s1')).toEqual(first);
    expect(findOnlineCredentials(storage,first.serverUrl,'s2')).toEqual({...second,autoResume:false});
    expect(findOnlineCredentials(storage,'wss://other.test/ws','s1')).toBeNull();
  });
  it('persists selected create blinds and reuses the same proof only for the same configuration', async () => {
    const { prepareAdmission, loadPendingAdmission } = await import('../../assets/scripts/net/OnlineCredentials');
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const config = { smallBlind: 50, bigBlind: 100 };
    const first = prepareAdmission(storage, 'wss://example.test/ws', 'A', undefined, config);
    config.bigBlind = 200;
    expect(first.message).toMatchObject({ type: 'createRoom', blinds: { smallBlind: 50, bigBlind: 100 } });
    expect(prepareAdmission(storage, 'wss://example.test/ws', 'A', undefined, { smallBlind: 50, bigBlind: 100 })).toEqual(first);
    expect(() => prepareAdmission(storage, 'wss://example.test/ws', 'A', undefined, { smallBlind: 50, bigBlind: 200 })).toThrow(/盲注/);
    expect(loadPendingAdmission(storage, 'wss://example.test/ws')).toEqual(first);
  });

  it('saves caller generated pending admission before a transport can send it', async () => {
    const { prepareAdmission, loadPendingAdmission } = await import('../../assets/scripts/net/OnlineCredentials');
    const storage=new MemoryStorage();
    const pending=prepareAdmission(storage,'wss://example.test/ws','A',{roomCode:'AB23',sessionId:'s1'});
    expect(pending.message).toMatchObject({type:'joinRoom',sessionId:'s1',roomCode:'AB23'});
    expect(pending.message.token).toMatch(/^[a-f0-9]{64}$/);
    expect(pending.message.requestId.length).toBeGreaterThanOrEqual(32);
    expect(loadPendingAdmission(storage,'wss://example.test/ws')).toEqual(pending);
  });
});

describe('v3 corrupt credential boundaries',()=>{
 it('rejects partial stable identities and corrupt indexed proofs without throwing',async()=>{
  const {listOnlineCredentials}=await import('../../assets/scripts/net/OnlineCredentials');
  const base={roomCode:'AB23',token:'proof',nickname:'A',serverUrl:'wss://example.test/ws'};
  for(const extra of [{sessionId:'s'},{sessionId:'s',playerId:2},{sessionId:'s',playerId:'p1',autoResume:'yes'}])expect(parseOnlineCredentials(JSON.stringify({...base,...extra}))).toBeNull();
  const storage=new MemoryStorage();storage.setItem('texas-holdem.online.v3',JSON.stringify({active:null,proofs:{bad:null}}));
  expect(listOnlineCredentials(storage,base.serverUrl)).toEqual([]);
 });
 it('rejects a corrupt pending admission instead of resending missing required proof scope',async()=>{
  const {loadPendingAdmission}=await import('../../assets/scripts/net/OnlineCredentials');
  const storage=new MemoryStorage();storage.setItem('texas-holdem.admission.v3',JSON.stringify({serverUrl:'wss://example.test/ws',message:{type:'joinRoom',requestId:'r',token:'a'.repeat(64)}}));
  expect(loadPendingAdmission(storage,'wss://example.test/ws')).toBeNull();
 });
});
