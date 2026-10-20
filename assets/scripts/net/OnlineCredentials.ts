import { ClientMessage, parseClientMessage, DEFAULT_SERVER_URL, ONLINE_SESSION_STORAGE_KEY } from './protocol';
import { assertBlinds, BlindConfig, normalizeBlinds } from '../core/Blinds';

export interface OnlineCredentials {
  sessionId?: string;
  playerId?: string;
  autoResume?: boolean;
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

  const stable = candidate.sessionId===undefined && candidate.playerId===undefined
    || typeof candidate.sessionId==='string' && candidate.sessionId.length>0 && typeof candidate.playerId==='string' && candidate.playerId.length>0;
  const active = candidate.autoResume===undefined || typeof candidate.autoResume==='boolean';
  return valid && stable && active ? (candidate as unknown as OnlineCredentials) : null;
}

const INDEX_KEY = 'texas-holdem.online.v3';
const PENDING_KEY = 'texas-holdem.admission.v3';
interface CredentialIndex { active: string | null; proofs: Record<string, OnlineCredentials> }
function identityKey(endpoint: string, sessionId: string): string { return JSON.stringify([normalizeServerUrl(endpoint),sessionId]); }
function readIndex(storage: OnlineStorage): CredentialIndex {
  try {
    const raw=JSON.parse(storage.getItem(INDEX_KEY) ?? 'null');
    if (raw && typeof raw.proofs==='object' && raw.proofs) return raw;
  } catch { /* Corrupt local state cannot become a new proof. */ }
  return {active:null,proofs:{}};
}
export function loadOnlineCredentials(storage: OnlineStorage): OnlineCredentials | null {
  const index=readIndex(storage);
  if (storage.getItem(INDEX_KEY)!==null) return index.active ? parseOnlineCredentials(JSON.stringify(index.proofs[index.active])) : null;
  return parseOnlineCredentials(storage.getItem(ONLINE_SESSION_STORAGE_KEY));
}
export function findOnlineCredentials(storage: OnlineStorage, endpoint: string, sessionId: string): OnlineCredentials | null {
  const proof=readIndex(storage).proofs[identityKey(endpoint,sessionId)];
  return proof ? parseOnlineCredentials(JSON.stringify(proof)) : null;
}
export function listOnlineCredentials(storage: OnlineStorage, endpoint: string): OnlineCredentials[] {
  const proofs=readIndex(storage).proofs;
  return Object.keys(proofs).map(key=>parseOnlineCredentials(JSON.stringify(proofs[key]))).filter((proof):proof is OnlineCredentials=>proof!==null && normalizeServerUrl(proof.serverUrl)===normalizeServerUrl(endpoint));
}
export function deactivateOnlineCredentials(storage: OnlineStorage, credentials: OnlineCredentials): void {
  if (!credentials.sessionId) { clearMatchingOnlineCredentials(storage,credentials); return; }
  const index=readIndex(storage);const key=identityKey(credentials.serverUrl,credentials.sessionId);
  const proof=index.proofs[key];
  if (!proof || proof.token!==credentials.token) return;
  index.proofs[key]={...proof,autoResume:false};
  if(index.active===key) index.active=null;
  storage.setItem(INDEX_KEY,JSON.stringify(index));
}
export function highEntropyId(bytes=32): string {
  const random=new Uint8Array(bytes);
  if (!globalThis.crypto?.getRandomValues) throw new Error('当前环境不支持安全随机凭证，请使用受支持的浏览器');
  globalThis.crypto.getRandomValues(random);
  return Array.from(random).map(value=>('0'+value.toString(16)).slice(-2)).join('');
}
export interface PendingAdmission {
  serverUrl: string;
  message: Extract<ClientMessage,{type:'createRoom'}> | Extract<ClientMessage,{type:'joinRoom'}>;
}
export function prepareAdmission(storage: OnlineStorage, serverUrl: string, nickname: string, target?: {roomCode:string;sessionId:string}, blinds?: BlindConfig): PendingAdmission {
  if (!target && blinds !== undefined) assertBlinds(blinds);
  const selectedBlinds = normalizeBlinds(blinds);
  const existing=loadPendingAdmission(storage,serverUrl);
  const type=target ? 'joinRoom' : 'createRoom';
  if (existing && existing.message.type===type && existing.message.nickname===nickname
    && (type==='createRoom' || (existing.message.type==='joinRoom' && existing.message.sessionId===target.sessionId && existing.message.roomCode===target.roomCode))) {
    if (existing.message.type === 'createRoom') {
      const previous = normalizeBlinds(existing.message.blinds);
      if (previous.smallBlind !== selectedBlinds.smallBlind || previous.bigBlind !== selectedBlinds.bigBlind) {
        throw new Error(`上次建房结果尚未确认，请先将盲注恢复为 ${previous.smallBlind} / ${previous.bigBlind} 后重试。`);
      }
    }
    return existing;
  }
  const common={nickname,requestId:highEntropyId(),token:highEntropyId()};
  const pending:PendingAdmission={serverUrl,message:target ? {type:'joinRoom',...target,...common} : {type:'createRoom',...common,blinds:selectedBlinds}};
  storage.setItem(PENDING_KEY,JSON.stringify(pending));
  return pending;
}
export function loadPendingAdmission(storage: OnlineStorage, endpoint: string): PendingAdmission | null {
  try {
    const pending=JSON.parse(storage.getItem(PENDING_KEY) ?? 'null');
    if (pending && parseClientMessage(pending.message)!==null && normalizeServerUrl(pending.serverUrl)!==null && normalizeServerUrl(pending.serverUrl)===normalizeServerUrl(endpoint)
      && (pending.message.type==='createRoom' || pending.message.type==='joinRoom')
      && /^[a-f0-9]{64}$/.test(pending.message.token) && typeof pending.message.requestId==='string') return pending;
  } catch { /* Ignore corrupt storage. */ }
  return null;
}
export function clearPendingAdmission(storage: OnlineStorage, requestId: string): void {
  try { const raw=JSON.parse(storage.getItem(PENDING_KEY)??'null'); if(raw?.message?.requestId===requestId) storage.removeItem(PENDING_KEY); } catch { /* No valid pending admission. */ }
}

export function saveOnlineCredentials(storage: OnlineStorage, credentials: OnlineCredentials): void {
  if (credentials.sessionId && credentials.playerId) {
    const index=readIndex(storage);const key=identityKey(credentials.serverUrl,credentials.sessionId);
    index.proofs[key]={...credentials,autoResume:credentials.autoResume!==false};
    index.active=credentials.autoResume===false ? null : key;
    storage.setItem(INDEX_KEY,JSON.stringify(index));
  } else storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify(credentials));
}

export function clearOnlineCredentials(storage: OnlineStorage): void {
  const index=readIndex(storage);
  if(index.active) delete index.proofs[index.active];
  index.active=null;
  if(storage.getItem(INDEX_KEY)!==null) storage.setItem(INDEX_KEY,JSON.stringify(index));
  storage.removeItem(ONLINE_SESSION_STORAGE_KEY);
}

export function resolveServerUrl(storage: OnlineStorage, locationSearch: string, pageUrl?: string): string {
  const params = new URLSearchParams(locationSearch);
  if (params.has('room')) {
    return resolveInvitationServerUrl(pageUrl ?? '');
  }
  const fromUrl = params.get('server');

  if (fromUrl) {
    return fromUrl;
  }

  const stored = loadOnlineCredentials(storage)?.serverUrl;
  if (stored !== undefined) {
    return stored;
  }

  if (pageUrl) {
    try {
      const page = new URL(pageUrl);
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].indexOf(page.hostname) !== -1;
      if (!isLocal && (page.protocol === 'http:' || page.protocol === 'https:')) {
        return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/ws`;
      }
    } catch {
      // Native contexts and malformed page locations keep the local development default.
    }
  }

  return DEFAULT_SERVER_URL;
}


/** Only forget the identity this session owns; a later tab may have replaced it. */
export function clearMatchingOnlineCredentials(storage: OnlineStorage, credentials: OnlineCredentials): void {
  const stored = loadOnlineCredentials(storage);
  if (stored
    && stored.roomCode === credentials.roomCode
    && stored.token === credentials.token
    && stored.nickname === credentials.nickname
    && stored.serverUrl === credentials.serverUrl) {
    clearOnlineCredentials(storage);
  }
}

/** Canonicalize the complete endpoint without treating distinct routes as one server. */
export function normalizeServerUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl.trim());
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password || url.hash) {
      return null;
    }
    // Sorting keys preserves the order of repeated values, which can carry meaning.
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

/** Invitations follow the site deployment, never a stored or query-string override. */
export function resolveInvitationServerUrl(pageUrl: string): string {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    throw new Error('当前站点无法确定邀请服务器，请使用游戏站点链接。');
  }
  if ((page.protocol !== 'http:' && page.protocol !== 'https:') || page.username || page.password) {
    throw new Error('当前站点不支持生成或打开邀请。');
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].indexOf(page.hostname) !== -1;
  if (isLocal) {
    return DEFAULT_SERVER_URL;
  }
  return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/ws`;
}
