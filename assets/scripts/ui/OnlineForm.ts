import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../net/protocol';

export interface OnlineFormValues {
  nickname: string;
  serverUrl: string;
  roomCode: string;
}

export function validateOnlineForm(
  values: OnlineFormValues,
  mode: 'create' | 'join',
  securePage: boolean,
): string | null {
  const nickname = values.nickname.trim();
  if (nickname.length < 1 || nickname.length > 12) {
    return '请输入 1–12 个字符的昵称';
  }

  let serverUrl: URL;
  try {
    serverUrl = new URL(values.serverUrl.trim());
  } catch {
    return '请输入有效的 ws:// 或 wss:// 服务器地址';
  }

  if (!serverUrl.hostname || (serverUrl.protocol !== 'ws:' && serverUrl.protocol !== 'wss:')) {
    return '请输入有效的 ws:// 或 wss:// 服务器地址';
  }

  if (securePage && serverUrl.protocol === 'ws:') {
    return 'HTTPS 页面请使用 wss:// 服务器地址';
  }

  if (mode === 'join') {
    const roomCode = values.roomCode.trim().toUpperCase();
    if (roomCode.length !== ROOM_CODE_LENGTH || roomCode.split('').some((character) => !ROOM_CODE_ALPHABET.includes(character))) {
      return '请输入有效的 4 位房间码';
    }
  }

  return null;
}
