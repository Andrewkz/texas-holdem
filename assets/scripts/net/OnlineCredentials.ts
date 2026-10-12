import { DEFAULT_SERVER_URL, ONLINE_SESSION_STORAGE_KEY } from './protocol';

export interface OnlineCredentials {
  roomCode: string;
  token: string;
  nickname: string;
  serverUrl: string;
}

export interface OnlineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function parseOnlineCredentials(raw: string | null): OnlineCredentials | null {
  if (!raw) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const valid = ['roomCode', 'token', 'nickname', 'serverUrl']
    .every((key) => typeof candidate[key] === 'string');

  return valid ? (candidate as unknown as OnlineCredentials) : null;
}

export function loadOnlineCredentials(storage: OnlineStorage): OnlineCredentials | null {
  return parseOnlineCredentials(storage.getItem(ONLINE_SESSION_STORAGE_KEY));
}

export function saveOnlineCredentials(storage: OnlineStorage, credentials: OnlineCredentials): void {
  storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify(credentials));
}

export function clearOnlineCredentials(storage: OnlineStorage): void {
  storage.removeItem(ONLINE_SESSION_STORAGE_KEY);
}

export function resolveServerUrl(storage: OnlineStorage, locationSearch: string): string {
  const fromUrl = new URLSearchParams(locationSearch).get('server');

  if (fromUrl) {
    return fromUrl;
  }

  return loadOnlineCredentials(storage)?.serverUrl ?? DEFAULT_SERVER_URL;
}
