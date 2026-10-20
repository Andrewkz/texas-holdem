import { describe, expect, it } from 'vitest';

import { validateOnlineForm } from '../../assets/scripts/ui/OnlineForm';

const form = { nickname: '小明', serverUrl: 'ws://localhost:2567', roomCode: 'AB23' };

describe('online form preflight validation', () => {
  it.each(['', '   ', '1234567890123', '😀'.repeat(7)])('rejects invalid nickname %j', (nickname) => {
    expect(validateOnlineForm({ ...form, nickname }, 'create', false)).toBe('请输入 1–12 个字符的昵称');
  });

  it.each([' A ', '123456789012', '😀'.repeat(6)])('accepts protocol-compatible nickname %j', (nickname) => {
    expect(validateOnlineForm({ ...form, nickname }, 'create', false)).toBeNull();
  });

  it.each(['', 'localhost:2567', 'https://example.com', 'ftp://example.com', 'ws://', 'wss://:2567', 'ws://exa mple.com'])('rejects invalid server URL %j', (serverUrl) => {
    expect(validateOnlineForm({ ...form, serverUrl }, 'create', false)).toBe('请输入有效的 ws:// 或 wss:// 服务器地址');
  });

  it.each(['ws://localhost:2567', ' ws://127.0.0.1:2567 ', 'wss://poker.example.com/rooms'])('accepts WebSocket URL %j', (serverUrl) => {
    expect(validateOnlineForm({ ...form, serverUrl }, 'create', false)).toBeNull();
  });

  it('rejects insecure connections from an HTTPS page', () => {
    expect(validateOnlineForm(form, 'create', true)).toBe('HTTPS 页面请使用 wss:// 服务器地址');
    expect(validateOnlineForm({ ...form, serverUrl: 'wss://poker.example.com' }, 'create', true)).toBeNull();
  });

  it.each(['', 'AB2', 'AB234', 'AB I', 'AB0O', 'AB1L', 'AB2!'])('rejects invalid join code %j', (roomCode) => {
    expect(validateOnlineForm({ ...form, roomCode }, 'join', false)).toBe('请输入有效的 4 位房间码');
  });

  it('accepts normalized room codes using the protocol alphabet', () => {
    expect(validateOnlineForm({ ...form, roomCode: ' ab23 ' }, 'join', false)).toBeNull();
    expect(validateOnlineForm({ ...form, roomCode: 'YZ89' }, 'join', false)).toBeNull();
  });

  it('ignores room code when creating a room', () => {
    expect(validateOnlineForm({ ...form, roomCode: '' }, 'create', false)).toBeNull();
  });
});
