import { normalizeServerUrl, OnlineCredentials } from './OnlineCredentials';
import { normalizeRoomCode, RoomInvite } from './RoomInvite';
export type EntryIntent =
  | { kind: 'resume' | 'rejoin'; credentials: OnlineCredentials }
  | { kind: 'lookup'; roomCode: string }
  | { kind: 'join'; roomCode: string; sessionId: string }
  | { kind: 'setup' }
  | { kind: 'invalid' | 'legacy-unavailable'; message: string };
/** An invite code never authorizes transmitting a saved proof until lookup binds its current session. */
export function chooseEntryIntent(invite: RoomInvite, stored: OnlineCredentials | null,
  targetServerUrl: string, lookedUpSessionId?: string): EntryIntent {
  if (invite.kind === 'invalid') return { kind:'invalid',message:invite.message };
  if (invite.kind === 'valid' && !lookedUpSessionId) return {kind:'lookup',roomCode:invite.roomCode};
  const target=normalizeServerUrl(targetServerUrl);
  const matches=stored && normalizeRoomCode(stored.roomCode) && stored.token.trim() && target
    && normalizeServerUrl(stored.serverUrl)===target
    && (invite.kind==='none' || (stored.sessionId===lookedUpSessionId && stored.roomCode===invite.roomCode));
  if(matches) {
    if(!stored.sessionId || !stored.playerId) return {kind:'legacy-unavailable',message:'旧版联机身份无法恢复；请明确创建或加入新版本场。'};
    return {kind:stored.autoResume===false ? 'rejoin' : 'resume',credentials:stored};
  }
  if(invite.kind==='valid') return {kind:'join',roomCode:invite.roomCode,sessionId:lookedUpSessionId!};
  return {kind:'setup'};
}
