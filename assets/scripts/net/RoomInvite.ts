import { normalizeServerUrl, resolveInvitationServerUrl } from './OnlineCredentials';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './protocol';

export type RoomInvite =
  | { kind: 'none' }
  | { kind: 'valid'; roomCode: string }
  | { kind: 'invalid'; message: string };

export function normalizeRoomCode(input: string): string | null {
  const roomCode = input.trim().toUpperCase();
  if (roomCode.length !== ROOM_CODE_LENGTH
    || roomCode.split('').some((character) => ROOM_CODE_ALPHABET.indexOf(character) === -1)) {
    return null;
  }
  return roomCode;
}

export function parseRoomInvite(search: string): RoomInvite {
  const values = new URLSearchParams(search).getAll('room');
  if (values.length === 0) {
    return { kind: 'none' };
  }
  const roomCode = normalizeRoomCode(values[0]);
  if (!roomCode || values.some((value) => normalizeRoomCode(value) !== roomCode)) {
    return { kind: 'invalid', message: '邀请无效，请检查四位房间码或手动输入。' };
  }
  return { kind: 'valid', roomCode };
}

export function createRoomInvite(pageUrl: string, input: string, activeServerUrl?: string): string {
  const roomCode = normalizeRoomCode(input);
  if (!roomCode) {
    throw new Error('房间码无效，无法生成邀请。');
  }
  const target = resolveInvitationServerUrl(pageUrl);
  if (activeServerUrl !== undefined
    && normalizeServerUrl(activeServerUrl) !== normalizeServerUrl(target)) {
    throw new Error('当前房间使用其他服务器，本站无法生成有效邀请。');
  }
  const page = new URL(pageUrl);
  page.search = '';
  page.hash = '';
  page.searchParams.set('room', roomCode);
  return page.toString();
}
