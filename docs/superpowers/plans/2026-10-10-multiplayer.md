# 多人联机对战 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有单机德州扑克基础上新增好友私房联机对战：Node WebSocket 权威服务器 + 房间码建房 + 2–6 名真人短桌 + 游客昵称制。

**Architecture:** 服务器（`server/`，Node + tsx + ws）复用 `assets/scripts/core` 的 `PokerEngine` 做权威裁决，手牌只发本人；客户端（Cocos）新增 `assets/scripts/net/` 网络层，`GameBootstrap` 增加联机模式，由服务器推送驱动与单机相同的渲染/动画管线。协议类型放在 `assets/scripts/net/protocol.ts`，客户端与服务器共享。

**Tech Stack:** TypeScript、Cocos Creator 3.8.8（客户端）、Node + `ws` + `tsx`（服务器）、vitest（测试）、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-10-multiplayer-design.md`

---

## File Structure

**引擎（改动小）：**
- `assets/scripts/core/types.ts` — `EngineSnapshot` 增加 `dealerPlayerId` 字段
- `assets/scripts/core/PokerEngine.ts` — 新增 `createWithPlayers`（2–6 人）、heads-up 盲注修正、`initialDealerIndex` 选项

**共享协议：**
- `assets/scripts/net/protocol.ts` — 消息类型、错误码、常量、`parseClientMessage` 运行时校验（服务器用它来校验不可信输入）

**服务器（`server/`，独立 package.json）：**
- `server/src/types.ts` — `ClientConnection` 接口（传输无关）
- `server/src/Room.ts` — 单个房间：座位、阶段、引擎驱动、超时、断线处理
- `server/src/RoomManager.ts` — 房间表、房间码、连接状态、消息路由
- `server/src/server.ts` — `createWsServer(manager, port)`：ws ↔ RoomManager 适配
- `server/src/index.ts` — 生产入口，读 `PORT`（默认 2567）

**客户端：**
- `assets/scripts/net/NetClient.ts` — WebSocket 薄封装（可注入 socket factory，便于测试）
- `assets/scripts/net/OnlineCredentials.ts` — 令牌/房间码/服务器地址的存取与解析
- `assets/scripts/net/OnlineSession.ts` — 服务器消息 → 合成 `EngineEvent` + `EngineSnapshot`（服务器玩家 id → 视觉座位 id 映射）
- `assets/scripts/ui/HomeFlow.ts` — 新增 `online-setup` / `online-lobby` 界面状态
- `assets/scripts/bootstrap/GameBootstrap.ts` — 重构 `render` 接收快照参数；新增联机入口 UI（建房/加入面板 + 房间大厅）与联机牌桌接线

**测试：**
- `tests/core/PokerEngine.spec.ts` — 追加 `createWithPlayers` 用例
- `tests/net/protocol.spec.ts`、`tests/net/RoomLobby.spec.ts`、`tests/net/RoomHand.spec.ts`、`tests/net/RoomLifecycle.spec.ts`、`tests/net/Server.spec.ts`、`tests/net/NetClient.spec.ts`、`tests/net/OnlineSession.spec.ts`、`tests/net/OnlineCredentials.spec.ts`
- `tests/ui/HomeFlow.spec.ts` — 追加联机界面流转用例

**文档/配置：**
- `server/package.json`、`server/tsconfig.json`、根 `package.json`（加 devDeps 与脚本）、`README.md`

---

### Task 1: 引擎支持 2–6 人动态入座与 heads-up 盲注

**Files:**
- Modify: `assets/scripts/core/types.ts`（`EngineSnapshot` 加 `dealerPlayerId`）
- Modify: `assets/scripts/core/PokerEngine.ts`
- Test: `tests/core/PokerEngine.spec.ts`（追加 describe）

背景：引擎目前 `createSixSeat` 写死 6 个固定玩家；盲注总是庄家下家小盲，2 人局（heads-up）规则要求庄家本人下小盲且翻牌前庄家先行动。服务器每手用 `createWithPlayers` 重建引擎（携带筹码与庄家位），所以需要 `initialDealerIndex` 选项。

- [ ] **Step 1: 写失败测试**

在 `tests/core/PokerEngine.spec.ts` 末尾追加：

```ts
describe('createWithPlayers', () => {
  const two = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

  it('rejects tables with fewer than 2 or more than 6 players', () => {
    expect(() => PokerEngine.createWithPlayers([{ id: 'a', name: 'A' }])).toThrow('between 2 and 6');
    expect(() => PokerEngine.createWithPlayers(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, name: id })),
    )).toThrow('between 2 and 6');
  });

  it('posts the small blind from the dealer in heads-up play', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5 });
    const state = game.startHand();

    expect(state.dealerPlayerId).toBe('a');
    expect(state.players.find(({ id }) => id === 'a')).toMatchObject({ streetContribution: 20 });
    expect(state.players.find(({ id }) => id === 'b')).toMatchObject({ streetContribution: 40 });
    expect(state.actingPlayerId).toBe('a');
  });

  it('rotates the dealer to the next player on the following hand', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5 });
    game.startHand();
    game.act({ type: 'fold' });
    expect(game.snapshot().street).toBe('settled');

    const next = game.startHand();
    expect(next.dealerPlayerId).toBe('b');
    expect(next.players.find(({ id }) => id === 'b')).toMatchObject({ streetContribution: 20 });
  });

  it('honours initialDealerIndex when recreating a table', () => {
    const game = PokerEngine.createWithPlayers(two, { random: () => 0.5, initialDealerIndex: 0 });
    expect(game.startHand().dealerPlayerId).toBe('b');
  });

  it('keeps the standard blind order with three or more players', () => {
    const game = PokerEngine.createWithPlayers(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      { random: () => 0.5 },
    );
    const state = game.startHand();

    expect(state.dealerPlayerId).toBe('a');
    expect(state.players.find(({ id }) => id === 'b')).toMatchObject({ streetContribution: 20 });
    expect(state.players.find(({ id }) => id === 'c')).toMatchObject({ streetContribution: 40 });
    expect(state.actingPlayerId).toBe('a');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/core/PokerEngine.spec.ts`
Expected: FAIL — `PokerEngine.createWithPlayers is not a function`

- [ ] **Step 3: 实现**

`assets/scripts/core/types.ts` — `EngineSnapshot` 增加一行：

```ts
export interface EngineSnapshot {
  handId: number;
  street: Street;
  actingPlayerId: string | null;
  dealerPlayerId: string | null;
  pot: number;
  communityCards: Card[];
  legalActions: PlayerAction[];
  players: readonly PlayerSnapshot[];
}
```

`assets/scripts/core/PokerEngine.ts` — 四处修改：

1. 选项接口改名并加字段（第 10–14 行）：

```ts
interface CreateEngineOptions {
  deck?: Deck;
  random?: () => number;
  stacks?: Partial<Record<string, number>>;
  initialDealerIndex?: number;
}
```

2. 构造器与工厂（第 34–49 行）替换为：

```ts
  private constructor(options: CreateEngineOptions, players: PlayerState[]) {
    this.firstDeck = options.deck ?? null;
    this.random = options.random ?? Math.random;
    this.players = players;
    this.dealerIndex = options.initialDealerIndex ?? -1;
  }

  public static createSixSeat(options: CreateEngineOptions = {}): PokerEngine {
    return PokerEngine.createWithPlayers([
      { id: 'ai-1', name: 'Nora' },
      { id: 'ai-2', name: 'Miles' },
      { id: 'ai-3', name: 'Aria' },
      { id: 'ai-4', name: 'Leo' },
      { id: 'ai-5', name: 'Sora' },
      { id: 'player', name: '你' },
    ], options);
  }

  public static createWithPlayers(players: readonly { id: string; name: string }[], options: CreateEngineOptions = {}): PokerEngine {
    if (players.length < 2 || players.length > 6) {
      throw new Error('Need between 2 and 6 players');
    }

    return new PokerEngine(
      options,
      players.map((player) => createPlayer(player.id, player.name, options.stacks?.[player.id])),
    );
  }
```

3. heads-up 盲注（`startHand` 中第 78 行）：

```ts
    const smallBlindIndex = this.playingPlayers().length === 2
      ? this.dealerIndex
      : this.nextPlayingIndex(this.dealerIndex);
    const bigBlindIndex = this.nextPlayingIndex(smallBlindIndex);
```

4. `snapshot()`（第 157–167 行）增加 `dealerPlayerId`：

```ts
  public snapshot(): EngineSnapshot {
    return {
      handId: this.handId,
      street: this.street,
      actingPlayerId: this.actingPlayer?.id ?? null,
      dealerPlayerId: this.street === 'settled' ? null : this.players[this.dealerIndex]?.id ?? null,
      pot: this.players.reduce((total, player) => total + player.totalContribution, 0),
      communityCards: [...this.communityCards],
      legalActions: this.legalActions(),
      players: this.players.map(({ holeCards: _holeCards, ...player }) => ({ ...player })),
    };
  }
```

- [ ] **Step 4: 跑测试确认全部通过（含旧用例不回归）**

Run: `pnpm test`
Expected: 全部 PASS（旧用例使用 `createSixSeat`，断言行不受影响）

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/core/types.ts assets/scripts/core/PokerEngine.ts tests/core/PokerEngine.spec.ts
git commit -m "Support 2-6 player tables and heads-up blinds in engine"
```

---

### Task 2: 共享协议类型与入站消息校验

**Files:**
- Create: `assets/scripts/net/protocol.ts`
- Test: `tests/net/protocol.spec.ts`

纯 TypeScript、无 Cocos/Node 依赖，客户端与服务器共同引用。`parseClientMessage` 是服务器对不可信输入的唯一入口校验。

- [ ] **Step 1: 写失败测试**

Create `tests/net/protocol.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { parseClientMessage } from '../../assets/scripts/net/protocol';

describe('parseClientMessage', () => {
  it('parses a createRoom message and trims the nickname', () => {
    expect(parseClientMessage({ type: 'createRoom', nickname: '  Alice  ' }))
      .toEqual({ type: 'createRoom', nickname: 'Alice' });
  });

  it('parses joinRoom and reconnect messages', () => {
    expect(parseClientMessage({ type: 'joinRoom', roomCode: 'ABCD', nickname: 'Bob' }))
      .toEqual({ type: 'joinRoom', roomCode: 'ABCD', nickname: 'Bob' });
    expect(parseClientMessage({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' }))
      .toEqual({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' });
  });

  it('parses leaveRoom and startGame messages', () => {
    expect(parseClientMessage({ type: 'leaveRoom' })).toEqual({ type: 'leaveRoom' });
    expect(parseClientMessage({ type: 'startGame' })).toEqual({ type: 'startGame' });
  });

  it('parses every action variant', () => {
    expect(parseClientMessage({ type: 'action', action: { type: 'fold' } }))
      .toEqual({ type: 'action', action: { type: 'fold' } });
    expect(parseClientMessage({ type: 'action', action: { type: 'check' } }))
      .toEqual({ type: 'action', action: { type: 'check' } });
    expect(parseClientMessage({ type: 'action', action: { type: 'all-in' } }))
      .toEqual({ type: 'action', action: { type: 'all-in' } });
    expect(parseClientMessage({ type: 'action', action: { type: 'call', amount: 40 } }))
      .toEqual({ type: 'action', action: { type: 'call', amount: 40 } });
    expect(parseClientMessage({ type: 'action', action: { type: 'raise', to: 160 } }))
      .toEqual({ type: 'action', action: { type: 'raise', to: 160 } });
  });

  it('rejects malformed messages', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('createRoom')).toBeNull();
    expect(parseClientMessage({ type: 'nope' })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', nickname: 42 })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', nickname: '   ' })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', nickname: 'this-name-is-way-too-long' })).toBeNull();
    expect(parseClientMessage({ type: 'joinRoom', roomCode: 123, nickname: 'Bob' })).toBeNull();
    expect(parseClientMessage({ type: 'reconnect', roomCode: 'ABCD' })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'call' } })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'raise', to: 'big' } })).toBeNull();
    expect(parseClientMessage({ type: 'action', action: { type: 'surrender' } })).toBeNull();
    expect(parseClientMessage({ type: 'action' })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/protocol.spec.ts`
Expected: FAIL — 无法解析模块 `assets/scripts/net/protocol`

- [ ] **Step 3: 实现**

Create `assets/scripts/net/protocol.ts`：

```ts
import { Card, EngineSnapshot, PlayerAction } from '../core/types';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const MAX_SEATS = 6;
export const STARTING_STACK = 5000;
export const ACTION_TIMEOUT_MS = 30_000;
export const RECONNECT_WINDOW_MS = 60_000;
export const BETWEEN_HANDS_MS = 5_000;
export const DEFAULT_SERVER_URL = 'ws://localhost:2567';
export const ONLINE_SESSION_STORAGE_KEY = 'texas-holdem.online.v1';

export interface RoomSeat {
  playerId: string;
  nickname: string;
  stack: number;
  connected: boolean;
}

export interface RoomStateMessage {
  code: string;
  phase: 'lobby' | 'playing';
  hostId: string;
  seats: RoomSeat[];
}

export type ErrorCode =
  | 'bad-message'
  | 'room-not-found'
  | 'room-full'
  | 'nickname-taken'
  | 'not-host'
  | 'not-in-room'
  | 'game-not-started'
  | 'not-your-turn'
  | 'illegal-action';

export type ClientMessage =
  | { type: 'createRoom'; nickname: string }
  | { type: 'joinRoom'; roomCode: string; nickname: string }
  | { type: 'reconnect'; roomCode: string; token: string }
  | { type: 'leaveRoom' }
  | { type: 'startGame' }
  | { type: 'action'; action: PlayerAction };

export type ServerMessage =
  | { type: 'joined'; roomCode: string; token: string; playerId: string; room: RoomStateMessage }
  | { type: 'roomState'; room: RoomStateMessage }
  | { type: 'handStart'; handId: number; dealerPlayerId: string }
  | { type: 'yourHand'; handId: number; cards: Card[] }
  | { type: 'stateSync'; snapshot: EngineSnapshot }
  | { type: 'actionTaken'; playerId: string; action: PlayerAction; amount: number }
  | { type: 'showdown'; handId: number; reveals: { playerId: string; cards: Card[]; handName: string }[] }
  | { type: 'handResult'; handId: number; payouts: { playerId: string; amount: number; handName: string }[] }
  | { type: 'error'; code: ErrorCode; message: string };

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case 'createRoom': {
      const nickname = parseNickname(message.nickname);
      return nickname ? { type: 'createRoom', nickname } : null;
    }
    case 'joinRoom': {
      const nickname = parseNickname(message.nickname);
      return nickname && typeof message.roomCode === 'string'
        ? { type: 'joinRoom', roomCode: message.roomCode, nickname }
        : null;
    }
    case 'reconnect':
      return typeof message.roomCode === 'string' && typeof message.token === 'string'
        ? { type: 'reconnect', roomCode: message.roomCode, token: message.token }
        : null;
    case 'leaveRoom':
      return { type: 'leaveRoom' };
    case 'startGame':
      return { type: 'startGame' };
    case 'action': {
      const action = parsePlayerAction(message.action);
      return action ? { type: 'action', action } : null;
    }
    default:
      return null;
  }
}

function parseNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const nickname = raw.trim();
  return nickname.length >= 1 && nickname.length <= 12 ? nickname : null;
}

function parsePlayerAction(raw: unknown): PlayerAction | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const action = raw as Record<string, unknown>;

  switch (action.type) {
    case 'fold':
    case 'check':
    case 'all-in':
      return { type: action.type };
    case 'call':
      return typeof action.amount === 'number' ? { type: 'call', amount: action.amount } : null;
    case 'raise':
      return typeof action.to === 'number' ? { type: 'raise', to: action.to } : null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm vitest run tests/net/protocol.spec.ts && pnpm run typecheck:game`
Expected: PASS；typecheck 无错误（`tsconfig.game.json` include `assets/**/*.ts` 自动覆盖新文件）

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/net/protocol.ts tests/net/protocol.spec.ts
git commit -m "Add shared online protocol types and client message validation"
```

---

### Task 3: 服务器脚手架（package.json、tsconfig、依赖）

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Modify: `package.json`（根）

服务器是独立包，Render 部署时指向 `server/` 目录。本地开发时服务器代码通过 Node 向上查找到根 `node_modules` 解析 `ws`（根 package.json 也声明它，供 vitest 集成测试使用），所以本地不需要在 `server/` 里单独 install；但要在 `server/` 生成 lockfile 供部署使用。

- [ ] **Step 1: 创建服务器包配置**

Create `server/package.json`：

```json
{
  "name": "texas-holdem-server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "tsx": "^4.19.2",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.13",
    "typescript": "^5.6.3"
  }
}
```

Create `server/tsconfig.json`（与代码库一致 `strict: false`；`Bundler` 解析与 tsx 行为一致，允许无扩展名相对导入）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": false,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": [
    "src/**/*.ts",
    "../assets/scripts/core/**/*.ts",
    "../assets/scripts/net/protocol.ts"
  ]
}
```

- [ ] **Step 2: 根 package.json 加依赖与脚本**

根 `package.json` 的 `scripts` 改为：

```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck:game": "tsc --noEmit -p tsconfig.game.json",
    "typecheck:server": "tsc --noEmit -p server/tsconfig.json",
    "server:dev": "pnpm --dir server dev"
  },
```

- [ ] **Step 3: 安装依赖并生成服务器 lockfile**

```bash
pnpm add -D ws @types/ws @types/node
cd server && pnpm install && cd ..
```

Expected: 根 `node_modules` 出现 `ws`；`server/pnpm-lock.yaml` 生成。

- [ ] **Step 4: 验证 typecheck 通过**

Run: `pnpm run typecheck:server`
Expected: 通过（此时 `server/src` 尚为空目录，`include` 匹配不到文件时 tsc 可能报 "No inputs were found"；若报错则先执行 Task 4 再回来验证，或先放一个空的 `server/src/index.ts` 占位文件，Task 7 会覆盖它）

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml server/package.json server/tsconfig.json server/pnpm-lock.yaml
git commit -m "Scaffold server package and typecheck scripts"
```

---

### Task 4: 房间大厅（建房/加入/离开/房主移交/断线标记）

**Files:**
- Create: `server/src/types.ts`
- Create: `server/src/Room.ts`
- Create: `server/src/RoomManager.ts`
- Test: `tests/net/RoomLobby.spec.ts`

`RoomManager` 与传输层解耦：测试用假 `ClientConnection` 驱动，不碰真实 WebSocket。本任务只实现大厅阶段；`startGame`/`action` 先按 `not-in-room`/`game-not-started` 拒绝，Task 5 补全。

- [ ] **Step 1: 写失败测试**

Create `tests/net/fakes.ts`（测试共享工具，不是 spec 文件，不会被 vitest 当测试跑）：

```ts
import { ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { ClientConnection } from '../../server/src/types';

export class FakeConnection implements ClientConnection {
  public readonly sent: ServerMessage[] = [];

  public send(message: ServerMessage): void {
    this.sent.push(message);
  }

  public last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return [...this.sent].reverse().find((message): message is Extract<ServerMessage, { type: T }> => message.type === type);
  }
}

export function connect(manager: RoomManager): FakeConnection {
  const connection = new FakeConnection();
  manager.handleOpen(connection);
  return connection;
}

export function createRoom(manager: RoomManager, nickname = 'Alice') {
  const connection = connect(manager);
  manager.handleMessage(connection, { type: 'createRoom', nickname });
  const joined = connection.last('joined');

  if (!joined) {
    throw new Error('expected joined message');
  }

  return { connection, joined };
}

export function joinRoom(manager: RoomManager, roomCode: string, nickname: string) {
  const connection = connect(manager);
  manager.handleMessage(connection, { type: 'joinRoom', roomCode, nickname });
  const joined = connection.last('joined');

  if (!joined) {
    throw new Error('expected joined message');
  }

  return { connection, joined };
}
```

Create `tests/net/RoomLobby.spec.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, joinRoom } from './fakes';

describe('room lobby', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a room with a 4-char code and makes the creator host', () => {
    const manager = new RoomManager({ random: () => 0 });
    const { connection, joined } = createRoom(manager);

    expect(joined.roomCode).toMatch(/^[A-Z2-9]{4}$/);
    expect(joined.token.length).toBeGreaterThan(0);
    expect(joined.room.hostId).toBe(joined.playerId);
    expect(joined.room.phase).toBe('lobby');
    expect(joined.room.seats).toEqual([
      { playerId: joined.playerId, nickname: 'Alice', stack: 5000, connected: true },
    ]);
    expect(connection.last('roomState')?.room.seats).toHaveLength(1);
  });

  it('lets a second player join and broadcasts the updated roster', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    expect(bob.joined.room.seats).toHaveLength(2);
    expect(alice.connection.last('roomState')?.room.seats.map((seat) => seat.nickname)).toEqual(['Alice', 'Bob']);
    expect(bob.joined.room.hostId).toBe(alice.joined.playerId);
  });

  it('rejects joining an unknown room or a full room', () => {
    const manager = new RoomManager();
    const stranger = connect(manager);
    manager.handleMessage(stranger, { type: 'joinRoom', roomCode: 'ZZZZ', nickname: 'X' });
    expect(stranger.last('error')?.code).toBe('room-not-found');

    const alice = createRoom(manager);
    for (let index = 0; index < 5; index += 1) {
      joinRoom(manager, alice.joined.roomCode, `P${index}`);
    }
    const seventh = connect(manager);
    manager.handleMessage(seventh, { type: 'joinRoom', roomCode: alice.joined.roomCode, nickname: 'Lucky' });
    expect(seventh.last('error')?.code).toBe('room-full');
  });

  it('rejects duplicate nicknames in the same room', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const copycat = connect(manager);
    manager.handleMessage(copycat, { type: 'joinRoom', roomCode: alice.joined.roomCode, nickname: 'Alice' });
    expect(copycat.last('error')?.code).toBe('nickname-taken');
  });

  it('removes leavers and migrates the host', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    manager.handleMessage(alice.connection, { type: 'leaveRoom' });

    const state = bob.connection.last('roomState')!.room;
    expect(state.seats.map((seat) => seat.nickname)).toEqual(['Bob']);
    expect(state.hostId).toBe(bob.joined.playerId);
  });

  it('destroys the room when the last player leaves', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    expect(manager.roomCount()).toBe(1);

    manager.handleMessage(alice.connection, { type: 'leaveRoom' });
    expect(manager.roomCount()).toBe(0);
  });

  it('marks a closed connection as disconnected and restores it on reconnect', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');

    manager.handleClose(bob.connection);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(false);

    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });

    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);
    expect(alice.connection.last('roomState')?.room.seats[1].connected).toBe(true);
  });

  it('rejects reconnect with a bad token', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);
    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: 'wrong' });
    expect(back.last('error')?.code).toBe('room-not-found');
  });

  it('rejects startGame from a non-host and from a room with one player', () => {
    const manager = new RoomManager();
    const alice = createRoom(manager);

    manager.handleMessage(alice.connection, { type: 'startGame' });
    expect(alice.connection.last('error')?.code).toBe('bad-message');

    const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
    manager.handleMessage(bob.connection, { type: 'startGame' });
    expect(bob.connection.last('error')?.code).toBe('not-host');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/RoomLobby.spec.ts`
Expected: FAIL — 无法解析 `../../server/src/RoomManager`

- [ ] **Step 3: 实现**

Create `server/src/types.ts`：

```ts
import { ServerMessage } from '../../assets/scripts/net/protocol';

export interface ClientConnection {
  send(message: ServerMessage): void;
}
```

Create `server/src/Room.ts`：

```ts
import { randomUUID } from 'node:crypto';

import {
  ACTION_TIMEOUT_MS,
  BETWEEN_HANDS_MS,
  ErrorCode,
  MAX_SEATS,
  RECONNECT_WINDOW_MS,
  RoomStateMessage,
  ServerMessage,
  STARTING_STACK,
} from '../../assets/scripts/net/protocol';
import { ClientConnection } from './types';

export interface RoomPlayer {
  id: string;
  nickname: string;
  token: string;
  stack: number;
  connected: boolean;
  connection: ClientConnection | null;
  autoFold: boolean;
}

export interface RoomOptions {
  actionTimeoutMs?: number;
  reconnectWindowMs?: number;
  betweenHandsMs?: number;
}

export type JoinResult =
  | { ok: true; player: RoomPlayer }
  | { ok: false; code: ErrorCode; message: string };

export class Room {
  public phase: 'lobby' | 'playing' = 'lobby';
  public hostId = '';
  protected readonly players: RoomPlayer[] = [];
  protected readonly options: Required<RoomOptions>;
  private nextPlayerNumber = 1;

  public constructor(
    public readonly code: string,
    options: RoomOptions,
    private readonly onEmpty: () => void,
  ) {
    this.options = {
      actionTimeoutMs: options.actionTimeoutMs ?? ACTION_TIMEOUT_MS,
      reconnectWindowMs: options.reconnectWindowMs ?? RECONNECT_WINDOW_MS,
      betweenHandsMs: options.betweenHandsMs ?? BETWEEN_HANDS_MS,
    };
  }

  public addPlayer(nickname: string, connection: ClientConnection): JoinResult {
    if (this.seatedPlayers().length >= MAX_SEATS) {
      return { ok: false, code: 'room-full', message: '房间已满' };
    }

    if (this.players.some((player) => player.nickname === nickname && !player.autoFold)) {
      return { ok: false, code: 'nickname-taken', message: '昵称已被占用' };
    }

    const player: RoomPlayer = {
      id: `p${this.nextPlayerNumber}`,
      nickname,
      token: randomUUID(),
      stack: STARTING_STACK,
      connected: true,
      connection,
      autoFold: false,
    };
    this.nextPlayerNumber += 1;
    this.players.push(player);

    if (!this.hostId) {
      this.hostId = player.id;
    }

    this.broadcastRoomState();
    return { ok: true, player };
  }

  public reconnectPlayer(token: string, connection: ClientConnection): RoomPlayer | null {
    const player = this.players.find((candidate) => candidate.token === token) ?? null;

    if (!player) {
      return null;
    }

    player.connected = true;
    player.connection = connection;
    this.broadcastRoomState();
    return player;
  }

  public markDisconnected(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      return;
    }

    player.connected = false;
    player.connection = null;
    this.broadcastRoomState();
  }

  public removePlayer(playerId: string): void {
    const index = this.players.findIndex((candidate) => candidate.id === playerId);

    if (index === -1) {
      return;
    }

    this.players.splice(index, 1);

    if (this.hostId === playerId) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.players.length === 0) {
      this.onEmpty();
      return;
    }

    this.broadcastRoomState();
  }

  public roomState(): RoomStateMessage {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      seats: this.seatedPlayers().map((player) => ({
        playerId: player.id,
        nickname: player.nickname,
        stack: player.stack,
        connected: player.connected,
      })),
    };
  }

  public broadcastRoomState(): void {
    this.broadcast({ type: 'roomState', room: this.roomState() });
  }

  protected seatedPlayers(): RoomPlayer[] {
    return this.players.filter((player) => !player.autoFold);
  }

  protected broadcast(message: ServerMessage): void {
    for (const player of this.players) {
      player.connection?.send(message);
    }
  }

  protected sendTo(player: RoomPlayer, message: ServerMessage): void {
    player.connection?.send(message);
  }
}
```

Create `server/src/RoomManager.ts`：

```ts
import {
  ClientMessage,
  ErrorCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ServerMessage,
} from '../../assets/scripts/net/protocol';
import { Room, RoomOptions } from './Room';
import { ClientConnection } from './types';

export interface RoomManagerOptions extends RoomOptions {
  random?: () => number;
}

interface ConnectionState {
  roomCode: string | null;
  playerId: string | null;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly states = new Map<ClientConnection, ConnectionState>();
  private readonly random: () => number;
  private readonly roomOptions: RoomOptions;

  public constructor(options: RoomManagerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.roomOptions = {
      actionTimeoutMs: options.actionTimeoutMs,
      reconnectWindowMs: options.reconnectWindowMs,
      betweenHandsMs: options.betweenHandsMs,
    };
  }

  public handleOpen(connection: ClientConnection): void {
    this.states.set(connection, { roomCode: null, playerId: null });
  }

  public handleClose(connection: ClientConnection): void {
    const state = this.states.get(connection);
    this.states.delete(connection);

    if (!state?.roomCode || !state.playerId) {
      return;
    }

    this.rooms.get(state.roomCode)?.markDisconnected(state.playerId);
  }

  public handleMessage(connection: ClientConnection, message: ClientMessage): void {
    switch (message.type) {
      case 'createRoom': {
        const code = this.generateRoomCode();
        const room = new Room(code, this.roomOptions, () => this.rooms.delete(code));
        this.rooms.set(code, room);
        this.joinRoom(connection, room, message.nickname);
        return;
      }
      case 'joinRoom': {
        const room = this.rooms.get(message.roomCode.toUpperCase());

        if (!room) {
          this.sendError(connection, 'room-not-found', '房间不存在');
          return;
        }

        this.joinRoom(connection, room, message.nickname);
        return;
      }
      case 'reconnect': {
        const room = this.rooms.get(message.roomCode.toUpperCase());
        const player = room?.reconnectPlayer(message.token, connection) ?? null;

        if (!room || !player) {
          this.sendError(connection, 'room-not-found', '无法恢复座位');
          return;
        }

        this.states.set(connection, { roomCode: room.code, playerId: player.id });
        connection.send({
          type: 'joined',
          roomCode: room.code,
          token: player.token,
          playerId: player.id,
          room: room.roomState(),
        });
        return;
      }
      case 'leaveRoom': {
        const state = this.states.get(connection);
        const room = state?.roomCode ? this.rooms.get(state.roomCode) : undefined;

        if (!state?.roomCode || !state.playerId || !room) {
          this.sendError(connection, 'not-in-room', '你不在任何房间中');
          return;
        }

        room.removePlayer(state.playerId);
        this.states.set(connection, { roomCode: null, playerId: null });
        return;
      }
      case 'startGame': {
        const state = this.states.get(connection);
        const room = state?.roomCode ? this.rooms.get(state.roomCode) : undefined;

        if (!state?.roomCode || !state.playerId || !room) {
          this.sendError(connection, 'not-in-room', '你不在任何房间中');
          return;
        }

        if (state.playerId !== room.hostId) {
          this.sendError(connection, 'not-host', '只有房主可以开始游戏');
          return;
        }

        this.sendError(connection, 'bad-message', '至少需要 2 名玩家');
        return;
      }
      case 'action': {
        this.sendError(connection, 'game-not-started', '牌局尚未开始');
        return;
      }
    }
  }

  public roomCount(): number {
    return this.rooms.size;
  }

  private joinRoom(connection: ClientConnection, room: Room, nickname: string): void {
    const result = room.addPlayer(nickname, connection);

    if (!result.ok) {
      this.sendError(connection, result.code, result.message);
      return;
    }

    this.states.set(connection, { roomCode: room.code, playerId: result.player.id });
    connection.send({
      type: 'joined',
      roomCode: room.code,
      token: result.player.token,
      playerId: result.player.id,
      room: room.roomState(),
    });
  }

  private generateRoomCode(): string {
    let code = '';

    do {
      code = Array.from(
        { length: ROOM_CODE_LENGTH },
        () => ROOM_CODE_ALPHABET[Math.floor(this.random() * ROOM_CODE_ALPHABET.length)],
      ).join('');
    } while (this.rooms.has(code));

    return code;
  }

  private sendError(connection: ClientConnection, code: ErrorCode, message: string): void {
    connection.send({ type: 'error', code, message });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/net/RoomLobby.spec.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/types.ts server/src/Room.ts server/src/RoomManager.ts tests/net/fakes.ts tests/net/RoomLobby.spec.ts
git commit -m "Add room lobby management with reconnect tokens"
```

---

### Task 5: 房间牌局流程（开始、发牌、行动、摊牌、结算）

**Files:**
- Modify: `server/src/Room.ts`（新增引擎驱动方法）
- Modify: `server/src/RoomManager.ts`（`startGame`/`action` 路由到 Room）
- Test: `tests/net/RoomHand.spec.ts`

服务器每手用 `PokerEngine.createWithPlayers` 重建引擎，携带当前筹码与上一手庄家位；`handStart` 广播后逐个私信 `yourHand`；每次行动后广播 `actionTaken` + `stateSync`（公共快照，不含他人手牌）；摊牌与结算分别映射为 `showdown` 与 `handResult`。

- [ ] **Step 1: 写失败测试**

Create `tests/net/RoomHand.spec.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerAction } from '../../assets/scripts/core/types';
import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, joinRoom } from './fakes';

function createManager(): RoomManager {
  return new RoomManager({ betweenHandsMs: 100, actionTimeoutMs: 10_000, reconnectWindowMs: 10_000 });
}

function startTwoPlayerGame(manager: RoomManager) {
  const alice = createRoom(manager);
  const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
  manager.handleMessage(alice.connection, { type: 'startGame' });
  return { alice, bob };
}

function passiveAction(manager: RoomManager, connection: Parameters<RoomManager['handleMessage']>[0], legalActions: PlayerAction[]): void {
  const action = legalActions.find((candidate) => candidate.type === 'check')
    ?? legalActions.find((candidate) => candidate.type === 'call');

  if (!action) {
    throw new Error('expected a passive legal action');
  }

  manager.handleMessage(connection, { type: 'action', action });
}

describe('room hand flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a hand, deals private hands and broadcasts public state', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const handStart = alice.connection.last('handStart')!;
    expect(handStart.handId).toBe(1);
    expect(bob.connection.last('handStart')).toEqual(handStart);

    const aliceHand = alice.connection.last('yourHand')!;
    const bobHand = bob.connection.last('yourHand')!;
    expect(aliceHand.cards).toHaveLength(2);
    expect(bobHand.cards).toHaveLength(2);

    // 私密性：Bob 收到的所有消息里绝不能出现 Alice 的牌
    const bobWire = JSON.stringify(bob.connection.sent);
    for (const card of aliceHand.cards) {
      expect(bobWire).not.toContain(JSON.stringify(card));
    }

    const sync = alice.connection.last('stateSync')!;
    expect(sync.snapshot.street).toBe('preflop');
    expect(sync.snapshot.pot).toBe(60);
    expect(sync.snapshot.actingPlayerId).not.toBeNull();
    expect(sync.snapshot.players).toHaveLength(2);
    expect(JSON.stringify(sync)).not.toContain('holeCards');
    expect(alice.connection.last('roomState')!.room.phase).toBe('playing');
  });

  it('rejects actions from the wrong player or with illegal amounts', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const waiting = acting === alice ? bob : alice;

    manager.handleMessage(waiting.connection, { type: 'action', action: { type: 'fold' } });
    expect(waiting.connection.last('error')?.code).toBe('not-your-turn');

    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'raise', to: 10 } });
    expect(acting.connection.last('error')?.code).toBe('illegal-action');
  });

  it('broadcasts actionTaken and moves the turn', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    const call = sync.snapshot.legalActions.find((action) => action.type === 'call');

    manager.handleMessage(acting.connection, { type: 'action', action: call ?? { type: 'check' } });

    const taken = bob.connection.last('actionTaken')!;
    expect(taken.playerId).toBe(acting.joined.playerId);
    expect(alice.connection.last('stateSync')!.snapshot.actingPlayerId).not.toBe(acting.joined.playerId);
  });

  it('plays a full checked-down hand to showdown and starts the next hand automatically', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob };

    for (let guard = 0; guard < 40; guard += 1) {
      const sync = alice.connection.last('stateSync')!;
      if (sync.snapshot.street === 'settled') {
        break;
      }

      const acting = byId[sync.snapshot.actingPlayerId!];
      passiveAction(manager, acting.connection, sync.snapshot.legalActions);
    }

    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');

    const showdown = alice.connection.last('showdown')!;
    expect(showdown.reveals).toHaveLength(2);
    for (const reveal of showdown.reveals) {
      expect(reveal.cards).toHaveLength(2);
      expect(reveal.handName.length).toBeGreaterThan(0);
    }

    const result = alice.connection.last('handResult')!;
    const totalPayout = result.payouts.reduce((sum, payout) => sum + payout.amount, 0);
    expect(totalPayout).toBe(60);

    vi.advanceTimersByTime(150);
    expect(alice.connection.last('handStart')!.handId).toBe(2);
  });

  it('awards the pot immediately when a player folds preflop and reveals nothing', () => {
    const manager = createManager();
    const { alice, bob } = startTwoPlayerGame(manager);

    const sync = alice.connection.last('stateSync')!;
    const acting = sync.snapshot.actingPlayerId === alice.joined.playerId ? alice : bob;
    manager.handleMessage(acting.connection, { type: 'action', action: { type: 'fold' } });

    const result = bob.connection.last('handResult')!;
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].amount).toBe(60);
    expect(bob.connection.last('showdown')).toBeUndefined();

    // 弃牌收池后赢家筹码增加（5000 - 自己的盲注/投入 + 60）
    const winnerId = result.payouts[0].playerId;
    const roomState = alice.connection.last('roomState')!.room;
    const winnerSeat = roomState.seats.find((seat) => seat.playerId === winnerId)!;
    expect(winnerSeat.stack).toBeGreaterThan(5000 - 40);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/RoomHand.spec.ts`
Expected: FAIL — `handStart`/`stateSync` 等消息不存在（`last('handStart')` 为 undefined）

- [ ] **Step 3: 实现 Room 牌局驱动**

`server/src/Room.ts` 顶部 import 追加：

```ts
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { EngineEvent, PlayerAction } from '../../assets/scripts/core/types';
```

`Room` 类中新增字段：

```ts
  private engine: PokerEngine | null = null;
  private lastDealerIndex = -1;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private betweenHandsTimer: ReturnType<typeof setTimeout> | null = null;
```

`Room` 类中新增方法：

```ts
  public startGame(playerId: string): { ok: true } | { ok: false; code: ErrorCode; message: string } {
    if (playerId !== this.hostId) {
      return { ok: false, code: 'not-host', message: '只有房主可以开始游戏' };
    }

    if (this.phase !== 'lobby') {
      return { ok: false, code: 'bad-message', message: '牌局已开始' };
    }

    if (this.seatedPlayers().length < 2) {
      return { ok: false, code: 'bad-message', message: '至少需要 2 名玩家' };
    }

    this.startHand();
    return { ok: true };
  }

  public handleAction(playerId: string, action: PlayerAction): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player || !this.engine || this.phase !== 'playing') {
      if (player) {
        this.sendTo(player, { type: 'error', code: 'game-not-started', message: '牌局尚未开始' });
      }
      return;
    }

    if (this.engine.snapshot().actingPlayerId !== playerId) {
      this.sendTo(player, { type: 'error', code: 'not-your-turn', message: '还没轮到你行动' });
      return;
    }

    this.applyAction(playerId, action);
  }

  protected startHand(): void {
    const seated = this.seatedPlayers();

    if (seated.filter((player) => player.stack > 0).length < 2) {
      this.phase = 'lobby';
      this.engine = null;
      this.broadcastRoomState();
      return;
    }

    this.phase = 'playing';
    this.engine = PokerEngine.createWithPlayers(
      seated.map((player) => ({ id: player.id, name: player.nickname })),
      {
        stacks: Object.fromEntries(seated.map((player) => [player.id, player.stack])),
        initialDealerIndex: this.lastDealerIndex,
      },
    );

    const snapshot = this.engine.startHand();
    this.lastDealerIndex = Math.max(0, seated.findIndex((player) => player.id === snapshot.dealerPlayerId));
    this.broadcast({ type: 'handStart', handId: snapshot.handId, dealerPlayerId: snapshot.dealerPlayerId! });

    for (const player of seated) {
      this.sendTo(player, { type: 'yourHand', handId: snapshot.handId, cards: this.engine.getHoleCards(player.id) });
    }

    this.broadcastRoomState();
    this.broadcastStateSync();
    this.scheduleActionTimeout();
  }

  protected applyAction(playerId: string, action: PlayerAction): void {
    let events: EngineEvent[];

    try {
      events = this.engine!.act(action);
    } catch {
      const player = this.players.find((candidate) => candidate.id === playerId);
      if (player) {
        this.sendTo(player, { type: 'error', code: 'illegal-action', message: '行动不合法' });
      }
      return;
    }

    for (const event of events) {
      if (event.type === 'action-taken') {
        this.broadcast({ type: 'actionTaken', playerId: event.playerId, action: event.action, amount: event.amount });
      }
    }

    const reveals = events.filter((event): event is Extract<EngineEvent, { type: 'showdown' }> => event.type === 'showdown');
    if (reveals.length > 0) {
      this.broadcast({
        type: 'showdown',
        handId: reveals[0].handId,
        reveals: reveals.map((event) => ({ playerId: event.playerId, cards: event.cards, handName: event.handName })),
      });
    }

    const payouts = events.filter((event): event is Extract<EngineEvent, { type: 'pot-awarded' }> => event.type === 'pot-awarded');
    if (payouts.length > 0) {
      this.broadcast({
        type: 'handResult',
        handId: payouts[0].handId,
        payouts: payouts.map((event) => ({ playerId: event.playerId, amount: event.amount, handName: event.handName })),
      });
    }

    this.broadcastStateSync();

    if (this.engine!.snapshot().street === 'settled') {
      this.finishHand();
    } else {
      this.scheduleActionTimeout();
    }
  }

  protected broadcastStateSync(): void {
    if (!this.engine) {
      return;
    }

    this.broadcast({ type: 'stateSync', snapshot: this.engine.snapshot() });
  }

  protected scheduleActionTimeout(): void {
    // Task 6 实现行动超时；此处先占位，Task 6 替换。
  }

  protected clearActionTimer(): void {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  private finishHand(): void {
    this.clearActionTimer();

    for (const playerState of this.engine!.snapshot().players) {
      const player = this.players.find((candidate) => candidate.id === playerState.id);
      if (player) {
        player.stack = playerState.stack;
      }
    }

    this.broadcastRoomState();
    this.betweenHandsTimer = setTimeout(() => {
      this.betweenHandsTimer = null;
      this.startHand();
    }, this.options.betweenHandsMs);
  }
```

`server/src/RoomManager.ts` — `startGame` 分支替换为：

```ts
      case 'startGame': {
        const state = this.states.get(connection);
        const room = state?.roomCode ? this.rooms.get(state.roomCode) : undefined;

        if (!state?.roomCode || !state.playerId || !room) {
          this.sendError(connection, 'not-in-room', '你不在任何房间中');
          return;
        }

        const result = room.startGame(state.playerId);

        if (!result.ok) {
          this.sendError(connection, result.code, result.message);
        }
        return;
      }
```

`action` 分支替换为：

```ts
      case 'action': {
        const state = this.states.get(connection);
        const room = state?.roomCode ? this.rooms.get(state.roomCode) : undefined;

        if (!state?.roomCode || !state.playerId || !room) {
          this.sendError(connection, 'not-in-room', '你不在任何房间中');
          return;
        }

        room.handleAction(state.playerId, message.action);
        return;
      }
```

注意：Task 4 的 `startGame` 分支内联了 not-host 校验，本任务把它移入 `Room.startGame`。Task 4 大厅测试中非房主/单人开局两条用例收到的错误码不变（`not-host`、`bad-message`），继续通过。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/net/`
Expected: RoomLobby + RoomHand + protocol 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/Room.ts server/src/RoomManager.ts tests/net/RoomHand.spec.ts
git commit -m "Drive poker hands on the server with private hole cards"
```

---

### Task 6: 行动超时、断线窗口与手牌中移除座位

**Files:**
- Modify: `server/src/Room.ts`
- Modify: `server/src/RoomManager.ts`（`reconnect` 补发手牌状态）
- Test: `tests/net/RoomLifecycle.spec.ts`

规则（来自 spec）：行动超时 30 秒能过牌则过牌、否则弃牌；断线保留座位 60 秒，令牌重连恢复并补发 `handStart`/`yourHand`/`stateSync`；超时未归移除座位，手牌中标记 `autoFold`，轮到即弃，手牌结束后清出名单。

- [ ] **Step 1: 写失败测试**

Create `tests/net/RoomLifecycle.spec.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerAction } from '../../assets/scripts/core/types';
import { RoomManager } from '../../server/src/RoomManager';
import { connect, createRoom, joinRoom } from './fakes';

const OPTIONS = { actionTimeoutMs: 1_000, reconnectWindowMs: 2_000, betweenHandsMs: 10_000 };

function startTwoPlayerGame() {
  const manager = new RoomManager(OPTIONS);
  const alice = createRoom(manager);
  const bob = joinRoom(manager, alice.joined.roomCode, 'Bob');
  manager.handleMessage(alice.connection, { type: 'startGame' });
  return { manager, alice, bob };
}

describe('room lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-folds the acting player after the action timeout when check is not free', () => {
    const { manager, alice } = startTwoPlayerGame();
    const actingId = alice.connection.last('stateSync')!.snapshot.actingPlayerId!;

    vi.advanceTimersByTime(OPTIONS.actionTimeoutMs + 50);

    const taken = alice.connection.last('actionTaken')!;
    expect(taken.playerId).toBe(actingId);
    expect(taken.action).toEqual({ type: 'fold' });
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('settled');
  });

  it('auto-checks instead of folding when checking is free', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    const byId = { [alice.joined.playerId]: alice, [bob.joined.playerId]: bob };

    // 第一位玩家主动行动（call 或 check），之后轮到第二位，大盲位可以免费过牌
    const first = alice.connection.last('stateSync')!.snapshot;
    const firstActor = byId[first.actingPlayerId!];
    const call = first.legalActions.find((action: PlayerAction) => action.type === 'call');
    manager.handleMessage(firstActor.connection, { type: 'action', action: call ?? { type: 'check' } });

    const second = alice.connection.last('stateSync')!.snapshot;
    expect(second.legalActions.some((action: PlayerAction) => action.type === 'check')).toBe(true);

    vi.advanceTimersByTime(OPTIONS.actionTimeoutMs + 50);

    const taken = alice.connection.last('actionTaken')!;
    expect(taken.playerId).toBe(second.actingPlayerId);
    expect(taken.action).toEqual({ type: 'check' });
    expect(alice.connection.last('stateSync')!.snapshot.street).toBe('flop');
  });

  it('resends hand state when a player reconnects mid-hand', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    manager.handleClose(bob.connection);

    const back = connect(manager);
    manager.handleMessage(back, { type: 'reconnect', roomCode: alice.joined.roomCode, token: bob.joined.token });

    expect(back.last('joined')?.playerId).toBe(bob.joined.playerId);
    expect(back.last('handStart')?.handId).toBe(1);
    expect(back.last('yourHand')?.cards).toHaveLength(2);
    expect(back.last('stateSync')?.snapshot.street).toBe('preflop');
  });

  it('removes the seat after the reconnect window and auto-folds them out of the hand', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    manager.handleClose(bob.connection);
    vi.advanceTimersByTime(OPTIONS.reconnectWindowMs + 50);

    expect(alice.connection.last('roomState')!.room.seats).toHaveLength(1);

    // Alice（剩余玩家）做一个被动动作后，轮到 Bob 的引擎座位时被自动弃牌
    const sync = alice.connection.last('stateSync')!.snapshot;
    const call = sync.legalActions.find((action: PlayerAction) => action.type === 'call');
    manager.handleMessage(alice.connection, { type: 'action', action: call ?? { type: 'check' } });

    const folds = alice.connection.sent.filter(
      (message) => message.type === 'actionTaken' && message.action.type === 'fold' && message.playerId === bob.joined.playerId,
    );
    expect(folds.length).toBeGreaterThan(0);
    expect(alice.connection.last('handResult')?.payouts[0].playerId).toBe(alice.joined.playerId);
  });

  it('migrates the host when the host leaves mid-hand', () => {
    const { manager, alice, bob } = startTwoPlayerGame();
    manager.handleMessage(alice.connection, { type: 'leaveRoom' });

    const state = bob.connection.last('roomState')!.room;
    expect(state.hostId).toBe(bob.joined.playerId);
    expect(state.seats.map((seat) => seat.playerId)).toEqual([bob.joined.playerId]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/RoomLifecycle.spec.ts`
Expected: FAIL — 超时无自动行动；重连无 `handStart` 补发；断线不移除座位

- [ ] **Step 3: 实现**

`server/src/Room.ts` 修改/新增：

1. `markDisconnected` 替换为（启动重连窗口计时）：

```ts
  public markDisconnected(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      return;
    }

    player.connected = false;
    player.connection = null;
    this.broadcastRoomState();

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(playerId);
      if (!player.connected) {
        this.removePlayer(playerId);
      }
    }, this.options.reconnectWindowMs);
    this.reconnectTimers.set(playerId, timer);
  }
```

2. `reconnectPlayer` 替换为（清除重连计时）：

```ts
  public reconnectPlayer(token: string, connection: ClientConnection): RoomPlayer | null {
    const player = this.players.find((candidate) => candidate.token === token) ?? null;

    if (!player) {
      return null;
    }

    const timer = this.reconnectTimers.get(player.id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(player.id);
    }

    player.connected = true;
    player.connection = connection;
    this.broadcastRoomState();
    return player;
  }
```

3. 新增字段：

```ts
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

4. `removePlayer` 替换为（手牌中标记 autoFold 而不是直接移除）：

```ts
  public removePlayer(playerId: string): void {
    const player = this.players.find((candidate) => candidate.id === playerId);

    if (!player) {
      return;
    }

    const timer = this.reconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(playerId);
    }

    const inHand = this.phase === 'playing'
      && this.engine !== null
      && this.engine.snapshot().players.some((candidate) => candidate.id === playerId);

    if (inHand) {
      player.autoFold = true;
      player.connected = false;
      player.connection = null;

      const snapshot = this.engine!.snapshot();
      if (snapshot.actingPlayerId === playerId && snapshot.legalActions.length > 0) {
        this.applyAction(playerId, { type: 'fold' });
      }
    } else {
      this.players.splice(this.players.indexOf(player), 1);
    }

    if (this.hostId === playerId) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.seatedPlayers().length === 0) {
      this.clearActionTimer();
      if (this.betweenHandsTimer) {
        clearTimeout(this.betweenHandsTimer);
        this.betweenHandsTimer = null;
      }
      this.onEmpty();
      return;
    }

    this.broadcastRoomState();
  }
```

5. `scheduleActionTimeout` 占位实现替换为：

```ts
  protected scheduleActionTimeout(): void {
    this.clearActionTimer();

    const actingPlayerId = this.phase === 'playing' ? this.engine?.snapshot().actingPlayerId : null;
    if (!actingPlayerId) {
      return;
    }

    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      const snapshot = this.engine?.snapshot();

      if (!snapshot || snapshot.street === 'settled' || snapshot.actingPlayerId !== actingPlayerId) {
        return;
      }

      const passive = snapshot.legalActions.find((action) => action.type === 'check')
        ?? snapshot.legalActions.find((action) => action.type === 'fold');

      if (passive) {
        this.applyAction(actingPlayerId, passive);
      }
    }, this.options.actionTimeoutMs);
  }
```

6. `broadcastStateSync` 替换为（轮到 autoFold 玩家立即弃牌）：

```ts
  protected broadcastStateSync(): void {
    if (!this.engine) {
      return;
    }

    const snapshot = this.engine.snapshot();
    this.broadcast({ type: 'stateSync', snapshot });

    const acting = snapshot.actingPlayerId
      ? this.players.find((candidate) => candidate.id === snapshot.actingPlayerId)
      : null;

    if (acting?.autoFold && snapshot.legalActions.length > 0) {
      this.applyAction(acting.id, { type: 'fold' });
    }
  }
```

7. `finishHand` 中 `setTimeout` 回调替换为（清出 autoFold 玩家再开下一手）：

```ts
    this.betweenHandsTimer = setTimeout(() => {
      this.betweenHandsTimer = null;
      this.dropAutoFoldedPlayers();
      this.startHand();
    }, this.options.betweenHandsMs);
```

并新增私有方法：

```ts
  private dropAutoFoldedPlayers(): void {
    for (const player of [...this.players]) {
      if (player.autoFold) {
        this.players.splice(this.players.indexOf(player), 1);
      }
    }

    if (this.hostId && !this.seatedPlayers().some((player) => player.id === this.hostId)) {
      this.hostId = this.seatedPlayers()[0]?.id ?? '';
    }

    if (this.players.length === 0) {
      this.onEmpty();
      return;
    }

    this.broadcastRoomState();
  }
```

8. 新增 `resendHandState`（重连补发）：

```ts
  public resendHandState(player: RoomPlayer): void {
    if (!this.engine || this.phase !== 'playing') {
      return;
    }

    const snapshot = this.engine.snapshot();

    if (snapshot.players.some((candidate) => candidate.id === player.id)) {
      this.sendTo(player, { type: 'handStart', handId: snapshot.handId, dealerPlayerId: snapshot.dealerPlayerId! });
      this.sendTo(player, { type: 'yourHand', handId: snapshot.handId, cards: this.engine.getHoleCards(player.id) });
    }

    this.sendTo(player, { type: 'stateSync', snapshot });
  }
```

`server/src/RoomManager.ts` — `reconnect` 分支在发送 `joined` 之后追加一行：

```ts
        room.resendHandState(player);
```

- [ ] **Step 4: 跑测试确认通过（含前两个 spec 不回归）**

Run: `pnpm vitest run tests/net/`
Expected: 全部 PASS

注意：Task 4 的「断线标记」用例没有推进计时器，座位仍在重连窗口内，行为不变。

- [ ] **Step 5: Commit**

```bash
git add server/src/Room.ts server/src/RoomManager.ts tests/net/RoomLifecycle.spec.ts
git commit -m "Add action timeouts and reconnection window to rooms"
```

---

### Task 7: WebSocket 传输层与真实套接字集成测试

**Files:**
- Create: `server/src/server.ts`
- Create: `server/src/index.ts`（覆盖 Task 3 可能的占位文件）
- Test: `tests/net/Server.spec.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/net/Server.spec.ts`：

```ts
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { ClientMessage, ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';

class TestClient {
  public readonly messages: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private waiter: { type: ServerMessage['type']; resolve: (message: ServerMessage) => void } | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);

      if (this.waiter?.type === message.type) {
        this.waiter.resolve(message);
        this.waiter = null;
      }
    });
  }

  public static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new TestClient(socket);
  }

  public send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  public waitFor<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    const existing = this.messages.find((message) => message.type === type);

    if (existing) {
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }

    return new Promise((resolve) => {
      this.waiter = { type, resolve: resolve as (message: ServerMessage) => void };
    });
  }

  public close(): void {
    this.socket.close();
  }
}

describe('websocket server', () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  it('serves a full two-player hand over real sockets without leaking hole cards', async () => {
    const manager = new RoomManager({ betweenHandsMs: 60_000, actionTimeoutMs: 60_000 });
    wss = createWsServer(manager, 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;

    const alice = await TestClient.connect(port);
    const bob = await TestClient.connect(port);

    alice.send({ type: 'createRoom', nickname: 'Alice' });
    const joined = await alice.waitFor('joined');

    bob.send({ type: 'joinRoom', roomCode: joined.roomCode, nickname: 'Bob' });
    await bob.waitFor('joined');

    alice.send({ type: 'startGame' });
    const [aliceHand, bobHand] = await Promise.all([
      alice.waitFor('yourHand'),
      bob.waitFor('yourHand'),
    ]);

    expect(aliceHand.cards).toHaveLength(2);
    expect(bobHand.cards).toHaveLength(2);

    const bobWire = JSON.stringify(bob.messages);
    for (const card of aliceHand.cards) {
      expect(bobWire).not.toContain(JSON.stringify(card));
    }

    const sync = await alice.waitFor('stateSync');
    expect(sync.snapshot.pot).toBe(60);

    alice.close();
    bob.close();
  });

  it('rejects malformed JSON with a bad-message error', async () => {
    const manager = new RoomManager();
    wss = createWsServer(manager, 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;

    const raw = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => raw.once('open', () => resolve()));
    raw.send('not json');

    const error = await new Promise<{ code: string }>((resolve) => {
      raw.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(error.code).toBe('bad-message');

    raw.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/Server.spec.ts`
Expected: FAIL — 无法解析 `../../server/src/server`

- [ ] **Step 3: 实现**

Create `server/src/server.ts`：

```ts
import { WebSocket, WebSocketServer } from 'ws';

import { parseClientMessage, ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from './RoomManager';

export function createWsServer(manager: RoomManager, port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (socket: WebSocket) => {
    const connection = {
      send: (message: ServerMessage) => socket.send(JSON.stringify(message)),
    };
    manager.handleOpen(connection);

    socket.on('message', (data) => {
      let raw: unknown;

      try {
        raw = JSON.parse(data.toString());
      } catch {
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
        return;
      }

      const message = parseClientMessage(raw);

      if (!message) {
        connection.send({ type: 'error', code: 'bad-message', message: '无法解析的消息' });
        return;
      }

      manager.handleMessage(connection, message);
    });

    socket.on('close', () => manager.handleClose(connection));
  });

  return wss;
}
```

Create `server/src/index.ts`：

```ts
import { RoomManager } from './RoomManager';
import { createWsServer } from './server';

const port = Number(process.env.PORT ?? 2567);

createWsServer(new RoomManager(), port);
console.log(`texas-holdem server listening on :${port}`);
```

- [ ] **Step 4: 跑测试 + 服务器 typecheck**

Run: `pnpm vitest run tests/net/Server.spec.ts && pnpm run typecheck:server`
Expected: PASS；typecheck 无错误

- [ ] **Step 5: 手动冒烟（可选但推荐）**

```bash
pnpm --dir server start &
sleep 2
node -e "const ws=new (require('ws'))('ws://127.0.0.1:2567');ws.on('open',()=>ws.send(JSON.stringify({type:'createRoom',nickname:'A'})));ws.on('message',d=>{console.log(d.toString());process.exit(0)});"
kill %1
```

Expected: 打印出 `joined` 消息（含 4 位房间码与 token）

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/src/index.ts tests/net/Server.spec.ts
git commit -m "Add websocket transport for the room server"
```

---

### Task 8: 客户端传输层（NetClient）与凭证存取（OnlineCredentials）

**Files:**
- Create: `assets/scripts/net/NetClient.ts`
- Create: `assets/scripts/net/OnlineCredentials.ts`
- Test: `tests/net/NetClient.spec.ts`、`tests/net/OnlineCredentials.spec.ts`

`NetClient` 通过可注入的 socket factory 同时适配浏览器 `WebSocket` 与 Node `ws` 包（测试用）。凭证持久化沿用 `GameSettings` 的 storage 接口模式。

- [ ] **Step 1: 写失败测试**

Create `tests/net/OnlineCredentials.spec.ts`：

```ts
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
```

Create `tests/net/NetClient.spec.ts`：

```ts
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { NetClient } from '../../assets/scripts/net/NetClient';
import { ServerMessage } from '../../assets/scripts/net/protocol';
import { RoomManager } from '../../server/src/RoomManager';
import { createWsServer } from '../../server/src/server';

describe('NetClient', () => {
  let wss: WebSocketServer | null = null;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  it('connects, exchanges messages and reports closure', async () => {
    wss = createWsServer(new RoomManager(), 0);
    await new Promise<void>((resolve) => wss!.once('listening', resolve));
    const port = (wss.address() as AddressInfo).port;

    const client = new NetClient(`ws://127.0.0.1:${port}`, (url) => new WebSocket(url) as never);
    const received: ServerMessage[] = [];
    let closed = false;
    client.onMessage = (message) => received.push(message);
    client.onClose = () => {
      closed = true;
    };

    await client.connect();
    client.send({ type: 'createRoom', nickname: 'Alice' });

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (received.some((message) => message.type === 'joined')) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });

    const joined = received.find((message) => message.type === 'joined')!;
    expect(joined.roomCode).toMatch(/^[A-Z2-9]{4}$/);

    expect(closed).toBe(false);
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/NetClient.spec.ts tests/net/OnlineCredentials.spec.ts`
Expected: FAIL — 无法解析对应模块

- [ ] **Step 3: 实现**

Create `assets/scripts/net/NetClient.ts`：

```ts
import { ClientMessage, ServerMessage } from './protocol';

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

const defaultFactory: SocketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;

export class NetClient {
  public onMessage: ((message: ServerMessage) => void) | null = null;
  public onClose: (() => void) | null = null;
  private socket: WebSocketLike | null = null;

  public constructor(
    private readonly url: string,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.factory(this.url);
      this.socket = socket;

      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`无法连接服务器 ${this.url}`));
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          this.onMessage?.(message);
        } catch {
          // 忽略无法解析的推送
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this.onClose?.();
      };
    });
  }

  public send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  public close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
```

Create `assets/scripts/net/OnlineCredentials.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm vitest run tests/net/NetClient.spec.ts tests/net/OnlineCredentials.spec.ts && pnpm run typecheck:game`
Expected: PASS；typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/net/NetClient.ts assets/scripts/net/OnlineCredentials.ts tests/net/NetClient.spec.ts tests/net/OnlineCredentials.spec.ts
git commit -m "Add client websocket transport and online credential storage"
```

---

### Task 9: OnlineSession（服务器消息 → 视觉事件/快照）

**Files:**
- Create: `assets/scripts/net/OnlineSession.ts`
- Test: `tests/net/OnlineSession.spec.ts`

核心职责：
1. **座位映射**：服务器玩家 id → 视觉座位 id（`player` 恒为本地玩家，其余按座位顺序映射到 `ai-1`…`ai-5`）。
2. **事件合成**：把 `handStart`/`yourHand`/`actionTaken`/`showdown`/`handResult`/`stateSync` 翻译成 `GameBootstrap.playEvents` 认识的 `EngineEvent` 序列 + 翻译后的 `EngineSnapshot`。
3. **顺序播放**：所有更新进入 Promise 队列串行播放，避免动画交错。
4. **断线重连**：连接关闭后自动重连并发送 `reconnect`，成功则由服务器补发手牌状态恢复牌桌，多次失败回调 `onSessionLost`。

- [ ] **Step 1: 写失败测试**

Create `tests/net/OnlineSession.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { EngineEvent, EngineSnapshot } from '../../assets/scripts/core/types';
import { OnlineSession, TableUpdate } from '../../assets/scripts/net/OnlineSession';
import { ClientMessage, RoomStateMessage, ServerMessage } from '../../assets/scripts/net/protocol';

class FakeClient {
  public readonly sent: ClientMessage[] = [];
  public onMessage: ((message: ServerMessage) => void) | null = null;
  public onClose: (() => void) | null = null;
  public connectCalls = 0;

  public connect(): Promise<void> {
    this.connectCalls += 1;
    return Promise.resolve();
  }

  public send(message: ClientMessage): void {
    this.sent.push(message);
  }

  public close(): void {}

  public emit(message: ServerMessage): void {
    this.onMessage?.(message);
  }
}

const ROOM: RoomStateMessage = {
  code: 'ABCD',
  phase: 'playing',
  hostId: 'p1',
  seats: [
    { playerId: 'p1', nickname: 'Alice', stack: 5000, connected: true },
    { playerId: 'p2', nickname: 'Bob', stack: 5000, connected: true },
    { playerId: 'p3', nickname: 'Cara', stack: 5000, connected: true },
  ],
};

function snapshot(partial: Partial<EngineSnapshot>): EngineSnapshot {
  return {
    handId: 1,
    street: 'preflop',
    actingPlayerId: 'p1',
    dealerPlayerId: 'p1',
    pot: 60,
    communityCards: [],
    legalActions: [{ type: 'fold' }, { type: 'call', amount: 40 }],
    players: [
      { id: 'p1', name: 'Alice', stack: 4960, folded: false, allIn: false, streetContribution: 40, totalContribution: 40 },
      { id: 'p2', name: 'Bob', stack: 4980, folded: false, allIn: false, streetContribution: 20, totalContribution: 20 },
      { id: 'p3', name: 'Cara', stack: 5000, folded: false, allIn: false, streetContribution: 0, totalContribution: 0 },
    ],
    ...partial,
  };
}

function createSession() {
  const client = new FakeClient();
  const updates: TableUpdate[] = [];
  const rooms: RoomStateMessage[] = [];
  const session = new OnlineSession(client as never, {
    playerId: 'p2',
    credentials: { roomCode: 'ABCD', token: 'tok', nickname: 'Bob', serverUrl: 'ws://x' },
    handlers: {
      onTableUpdate: (update) => {
        updates.push(update);
        return Promise.resolve();
      },
      onRoomState: (room) => rooms.push(room),
      onSessionLost: () => undefined,
    },
    reconnectDelayMs: 1,
    maxReconnectAttempts: 1,
  });
  return { client, session, updates, rooms };
}

describe('OnlineSession', () => {
  it('maps server seats to visual seats with the local player at the bottom', () => {
    const { client, session, rooms } = createSession();

    client.emit({ type: 'roomState', room: ROOM });

    expect(rooms).toEqual([ROOM]);
    expect(session.seatNames()).toEqual(new Map([
      ['player', 'Bob（你）'],
      ['ai-1', 'Cara'],
      ['ai-2', 'Alice'],
    ]));
  });

  it('synthesizes hole-card events on handStart plus yourHand', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });

    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'yourHand', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });
    await session.whenIdle();

    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update.newHand).toBe(true);

    const own = update.events.filter((event) => event.type === 'hole-card-dealt' && event.playerId === 'player');
    expect(own).toEqual([
      { handId: 1, type: 'hole-card-dealt', playerId: 'player', card: { suit: 'S', rank: 14 }, faceDown: false },
      { handId: 1, type: 'hole-card-dealt', playerId: 'player', card: { suit: 'H', rank: 13 }, faceDown: false },
    ]);

    const others = update.events.filter((event) => event.type === 'hole-card-dealt' && event.playerId !== 'player');
    expect(others).toHaveLength(4);
    expect(others.every((event) => event.faceDown && !('card' in event && event.card))).toBe(true);
  });

  it('translates snapshot ids and synthesizes community reveals on stateSync', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });
    client.emit({ type: 'handStart', handId: 1, dealerPlayerId: 'p1' });
    client.emit({ type: 'yourHand', handId: 1, cards: [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 13 }] });

    client.emit({ type: 'stateSync', snapshot: snapshot({}) });
    client.emit({
      type: 'stateSync',
      snapshot: snapshot({
        street: 'flop',
        actingPlayerId: 'p2',
        communityCards: [{ suit: 'D', rank: 2 }, { suit: 'C', rank: 7 }, { suit: 'S', rank: 9 }],
      }),
    });
    await session.whenIdle();

    expect(updates).toHaveLength(3);

    const first = updates[1];
    expect(first.events).toHaveLength(0);
    expect(first.snapshot?.actingPlayerId).toBe('ai-2'); // p1 相对本地玩家 p2 是 ai-2
    expect(first.snapshot?.players.map((player) => player.id)).toEqual(['ai-2', 'player', 'ai-1']);

    const second = updates[2];
    expect(second.events.filter((event) => event.type === 'community-card-revealed')).toHaveLength(3);
    expect(second.snapshot?.actingPlayerId).toBe('player'); // 轮到本地玩家
  });

  it('translates actionTaken, showdown and handResult into engine events', async () => {
    const { client, session, updates } = createSession();
    client.emit({ type: 'roomState', room: ROOM });

    client.emit({ type: 'actionTaken', playerId: 'p1', action: { type: 'call', amount: 40 }, amount: 40 });
    client.emit({ type: 'showdown', handId: 1, reveals: [{ playerId: 'p3', cards: [{ suit: 'S', rank: 2 }, { suit: 'D', rank: 3 }], handName: '高牌' }] });
    client.emit({ type: 'handResult', handId: 1, payouts: [{ playerId: 'p3', amount: 60, handName: '高牌' }] });
    await session.whenIdle();

    expect((updates[0].events[0] as Extract<EngineEvent, { type: 'action-taken' }>).playerId).toBe('ai-2');
    expect((updates[1].events[0] as Extract<EngineEvent, { type: 'showdown' }>).playerId).toBe('ai-1');
    expect((updates[2].events[0] as Extract<EngineEvent, { type: 'pot-awarded' }>)).toMatchObject({ playerId: 'ai-1', amount: 60 });
  });

  it('sends actions to the server', () => {
    const { client, session } = createSession();
    session.sendAction({ type: 'raise', to: 160 });
    expect(client.sent).toEqual([{ type: 'action', action: { type: 'raise', to: 160 } }]);
  });

  it('reconnects with stored credentials when the socket closes', async () => {
    const { client } = createSession();
    client.onClose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.connectCalls).toBe(1);
    expect(client.sent).toContainEqual({ type: 'reconnect', roomCode: 'ABCD', token: 'tok' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/net/OnlineSession.spec.ts`
Expected: FAIL — 无法解析 `assets/scripts/net/OnlineSession`

- [ ] **Step 3: 实现**

Create `assets/scripts/net/OnlineSession.ts`：

```ts
import { Card, EngineEvent, EngineSnapshot, PlayerAction } from '../core/types';
import { NetClient } from './NetClient';
import { OnlineCredentials } from './OnlineCredentials';
import { RoomStateMessage, ServerMessage } from './protocol';

export interface TableUpdate {
  events: EngineEvent[];
  snapshot: EngineSnapshot | null;
  newHand: boolean;
}

export interface OnlineSessionHandlers {
  onTableUpdate: (update: TableUpdate) => Promise<void>;
  onRoomState: (room: RoomStateMessage) => void;
  onSessionLost: (message: string) => void;
}

export interface OnlineSessionOptions {
  playerId: string;
  credentials: OnlineCredentials;
  handlers: OnlineSessionHandlers;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

const VISUAL_SEAT_IDS = ['player', 'ai-1', 'ai-2', 'ai-3', 'ai-4', 'ai-5'] as const;

export class OnlineSession {
  private readonly handlers: OnlineSessionHandlers;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private latestRoom: RoomStateMessage | null = null;
  private visualIds = new Map<string, string>();
  private handId = 0;
  private communityCount = 0;
  private pendingDealEvents: EngineEvent[] = [];
  private needsReset = false;
  private queue: Promise<void> = Promise.resolve();
  private reconnecting = false;

  public constructor(
    private readonly client: NetClient,
    private readonly options: OnlineSessionOptions,
  ) {
    this.handlers = options.handlers;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;

    client.onMessage = (message) => this.handleMessage(message);
    client.onClose = () => {
      void this.tryReconnect();
    };
  }

  public sendAction(action: PlayerAction): void {
    this.client.send({ type: 'action', action });
  }

  public sendStartGame(): void {
    this.client.send({ type: 'startGame' });
  }

  public sendLeave(): void {
    this.client.onClose = null;
    this.client.send({ type: 'leaveRoom' });
    this.client.close();
  }

  public seatNames(): Map<string, string> {
    const names = new Map<string, string>();

    if (!this.latestRoom) {
      return names;
    }

    for (const seat of this.latestRoom.seats) {
      const visualId = this.visualIds.get(seat.playerId);

      if (visualId) {
        names.set(visualId, seat.playerId === this.options.playerId ? `${seat.nickname}（你）` : seat.nickname);
      }
    }

    return names;
  }

  public whenIdle(): Promise<void> {
    return this.queue;
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'roomState':
      case 'joined':
        this.handleRoomState(message.room);
        return;
      case 'handStart':
        this.handleHandStart(message.handId);
        return;
      case 'yourHand':
        this.handleYourHand(message.handId, message.cards);
        return;
      case 'stateSync':
        this.handleStateSync(message.snapshot);
        return;
      case 'actionTaken':
        this.enqueue({
          events: [{
            handId: this.handId,
            type: 'action-taken',
            playerId: this.visualId(message.playerId),
            action: message.action,
            amount: message.amount,
          }],
          snapshot: null,
          newHand: false,
        });
        return;
      case 'showdown':
        this.enqueue({
          events: message.reveals.map((reveal) => ({
            handId: message.handId,
            type: 'showdown' as const,
            playerId: this.visualId(reveal.playerId),
            cards: reveal.cards,
            handName: reveal.handName,
          })),
          snapshot: null,
          newHand: false,
        });
        return;
      case 'handResult':
        this.enqueue({
          events: message.payouts.map((payout) => ({
            handId: message.handId,
            type: 'pot-awarded' as const,
            playerId: this.visualId(payout.playerId),
            amount: payout.amount,
            handName: payout.handName,
          })),
          snapshot: null,
          newHand: false,
        });
        return;
      case 'error':
        return;
    }
  }

  private handleRoomState(room: RoomStateMessage): void {
    this.latestRoom = room;
    const ids = room.seats.map((seat) => seat.playerId);
    const selfIndex = ids.indexOf(this.options.playerId);
    const ordered = selfIndex === -1
      ? ids
      : ids.map((_, offset) => ids[(selfIndex + offset) % ids.length]);

    this.visualIds = new Map(
      ordered.map((serverId, index) => [serverId, VISUAL_SEAT_IDS[index]] as const),
    );
    this.handlers.onRoomState(room);
  }

  private handleHandStart(handId: number): void {
    this.handId = handId;
    this.communityCount = 0;
    this.needsReset = true;
    this.pendingDealEvents = [];

    for (const seat of this.latestRoom?.seats ?? []) {
      if (seat.playerId === this.options.playerId || seat.stack <= 0) {
        continue;
      }

      const visualId = this.visualIds.get(seat.playerId);

      if (!visualId) {
        continue;
      }

      this.pendingDealEvents.push(
        { handId, type: 'hole-card-dealt', playerId: visualId, faceDown: true },
        { handId, type: 'hole-card-dealt', playerId: visualId, faceDown: true },
      );
    }
  }

  private handleYourHand(handId: number, cards: Card[]): void {
    if (handId !== this.handId) {
      return;
    }

    const events: EngineEvent[] = [
      { handId, type: 'hole-card-dealt', playerId: 'player', card: cards[0], faceDown: false },
      { handId, type: 'hole-card-dealt', playerId: 'player', card: cards[1], faceDown: false },
      ...this.pendingDealEvents,
    ];
    this.pendingDealEvents = [];
    this.enqueue({ events, snapshot: null, newHand: this.takeReset() });
  }

  private handleStateSync(snapshot: EngineSnapshot): void {
    const events: EngineEvent[] = [...this.pendingDealEvents];
    this.pendingDealEvents = [];

    for (const card of snapshot.communityCards.slice(this.communityCount)) {
      events.push({ handId: snapshot.handId, type: 'community-card-revealed', card });
    }

    this.communityCount = snapshot.communityCards.length;
    this.enqueue({ events, snapshot: this.translateSnapshot(snapshot), newHand: this.takeReset() });
  }

  private takeReset(): boolean {
    const reset = this.needsReset;
    this.needsReset = false;
    return reset;
  }

  private visualId(serverId: string): string {
    return this.visualIds.get(serverId) ?? serverId;
  }

  private translateSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
    return {
      ...snapshot,
      actingPlayerId: snapshot.actingPlayerId ? this.visualId(snapshot.actingPlayerId) : null,
      dealerPlayerId: snapshot.dealerPlayerId ? this.visualId(snapshot.dealerPlayerId) : null,
      players: snapshot.players.map((player) => ({ ...player, id: this.visualId(player.id) })),
    };
  }

  private enqueue(update: TableUpdate): void {
    this.queue = this.queue.then(() => this.handlers.onTableUpdate(update));
  }

  private async tryReconnect(): Promise<void> {
    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;

    for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelayMs));

      try {
        await this.client.connect();
        this.client.send({
          type: 'reconnect',
          roomCode: this.options.credentials.roomCode,
          token: this.options.credentials.token,
        });
        this.reconnecting = false;
        return;
      } catch {
        // 继续重试
      }
    }

    this.reconnecting = false;
    this.handlers.onSessionLost('与服务器断开连接，请重新加入房间');
  }
}
```

注意：`handleMessage` 中 `joined` 与 `roomState` 共用 `handleRoomState`，因为重连成功时服务器会重发 `joined`（含最新房间快照）。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm vitest run tests/net/OnlineSession.spec.ts && pnpm run typecheck:game`
Expected: PASS；typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/net/OnlineSession.ts tests/net/OnlineSession.spec.ts
git commit -m "Add online session translating server messages to table updates"
```

---

### Task 10: HomeFlow 增加联机界面状态

**Files:**
- Modify: `assets/scripts/ui/HomeFlow.ts`
- Test: `tests/ui/HomeFlow.spec.ts`（追加用例）

新增两个界面：`online-setup`（输入昵称/服务器/房间码）、`online-lobby`（等待房间）。`playing` 状态与单机共用，返回确认逻辑不变。

- [ ] **Step 1: 写失败测试**

在 `tests/ui/HomeFlow.spec.ts` 的 describe 内追加：

```ts
  it('enters the online setup from home and returns', () => {
    const home = createHomeFlow();
    const setup = reduceHomeFlow(home, { type: 'open-online' });

    expect(setup.screen).toBe('online-setup');
    expect(reduceHomeFlow(setup, { type: 'close-online' })).toEqual(home);
  });

  it('moves from setup to lobby and from lobby into the game', () => {
    const setup = reduceHomeFlow(createHomeFlow(), { type: 'open-online' });
    const lobby = reduceHomeFlow(setup, { type: 'entered-lobby' });

    expect(lobby.screen).toBe('online-lobby');
    expect(reduceHomeFlow(lobby, { type: 'leave-lobby' })).toEqual(createHomeFlow());
    expect(reduceHomeFlow(lobby, { type: 'online-game-start' }))
      .toEqual({ screen: 'playing', sessionActive: true });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/ui/HomeFlow.spec.ts`
Expected: FAIL — 新事件不改变状态

- [ ] **Step 3: 实现**

`assets/scripts/ui/HomeFlow.ts` 修改：

`HomeScreen` 类型改为：

```ts
export type HomeScreen = 'home' | 'rules' | 'settings' | 'online-setup' | 'online-lobby' | 'starting' | 'playing' | 'return-confirmation';
```

`HomeFlowEvent` 类型追加：

```ts
  | { type: 'open-online' }
  | { type: 'close-online' }
  | { type: 'entered-lobby' }
  | { type: 'leave-lobby' }
  | { type: 'online-game-start' };
```

`reduceHomeFlow` 的 `state.screen === 'home'` 分支内追加：

```ts
    if (event.type === 'open-online') {
      return { screen: 'online-setup', sessionActive: false };
    }
```

函数中追加两个新分支（放在 `starting` 分支之前即可）：

```ts
  if (state.screen === 'online-setup') {
    if (event.type === 'close-online') {
      return createHomeFlow();
    }
    if (event.type === 'entered-lobby') {
      return { screen: 'online-lobby', sessionActive: false };
    }
  }

  if (state.screen === 'online-lobby') {
    if (event.type === 'leave-lobby') {
      return createHomeFlow();
    }
    if (event.type === 'online-game-start') {
      return { screen: 'playing', sessionActive: true };
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/ui/HomeFlow.spec.ts`
Expected: 全部 PASS（旧用例不受影响）

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/ui/HomeFlow.ts tests/ui/HomeFlow.spec.ts
git commit -m "Add online setup and lobby screens to home flow"
```

---

### Task 11: GameBootstrap 渲染重构（联机前置）

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts`

为联机模式做三件小事，全部保持单机行为不变：
1. `render()` 改为接收 `EngineSnapshot` 参数（联机时快照来自服务器而非本地引擎）。
2. `SeatVisual` 增加 `name: Label` 并保存（联机时要动态改昵称），座位创建时把布局名字写进该 Label。
3. 结算文本与庄家标记改用座位名与 `dealerPlayerId`（修掉单机「D 恒在 ai-1」的旧问题）。

- [ ] **Step 1: 修改 `SeatVisual` 与 `createSeats`**

`SeatVisual` 接口增加 `name` 字段：

```ts
interface SeatVisual {
  id: string;
  node: Node;
  name: Label;
  chips: Label;
  action: Label;
  dealer: Label;
  highlight: Node;
  cards: CardVisual[];
  position: Vec3;
  nextCard: number;
}
```

`createSeats` 中把昵称 Label 存入变量（原来 `this.createLabel(node, name, 8, 16, 15, TEXT);` 一行改为）：

```ts
      const nameLabel = this.createLabel(node, name, 8, 16, 15, TEXT);
```

`this.seats.set(...)` 改为：

```ts
      this.seats.set(id, { id, node, name: nameLabel, chips, action, dealer, highlight, cards, position: new Vec3(x, y, 0), nextCard: 0 });
```

- [ ] **Step 2: `render()` 接收快照参数**

签名与首行改为：

```ts
  private render(state: EngineSnapshot): void {
```

删除原首行 `const state = this.engine.snapshot();`。

庄家标记一行（原来 `player.id === state.players[0].id ? 'D' : ...`）改为：

```ts
      seat.dealer.string = player.id === state.dealerPlayerId ? 'D' : player.streetContribution === 20 ? 'SB' : player.streetContribution === 40 ? 'BB' : '';
```

所有调用处改为传入快照：
- `startHand` 中 `this.render();` → `this.render(this.engine.snapshot());`
- `handlePlayerAction` 中 `this.render();` → `this.render(this.engine.snapshot());`
- `runAiTurns` 中两处 `this.render();` → `this.render(this.engine.snapshot());`
- `closeRaisePanel` 的回调 `() => this.render()` → `() => this.render(this.engine.snapshot())`
- `renderActionButtons` 内的 `this.render()` 调用没有，无需改。

`types.ts` 的 `EngineSnapshot` 需要在 import 中补充：`import { Card, EngineEvent, EngineSnapshot, PlayerAction, PlayerSnapshot, Street } from '../core/types';`（`PlayerSnapshot` 若已不再使用可从 import 移除，以 typecheck 为准）。

- [ ] **Step 3: 结算文本用座位名**

`playEvents` 中 `pot-awarded` 分支的：

```ts
        this.resultLabel.string = `${this.seats.get(event.playerId)!.id === 'player' ? '你' : 'AI'} 赢得 ${event.amount} · ${event.handName}`;
```

改为：

```ts
        this.resultLabel.string = `${this.seats.get(event.playerId)!.name.string} 赢得 ${event.amount} · ${event.handName}`;
```

- [ ] **Step 4: 验证**

Run: `pnpm run typecheck:game && pnpm test`
Expected: typecheck 无错误；测试全绿（纯 UI 重构，无测试变化）

再在 Cocos Creator 预览里手动打一手单机牌，确认座位昵称、庄家 D 标记（应跟随实际庄家轮换）、结算文本正常。

- [ ] **Step 5: Commit**

```bash
git add assets/scripts/bootstrap/GameBootstrap.ts
git commit -m "Refactor table rendering to accept snapshots for online play"
```

---

### Task 12: GameBootstrap 联机入口 UI（建房/加入面板 + 房间大厅）

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts`

首页「开始游戏」改为「单机游戏」，新增「联机对战」按钮 → 联机面板（昵称、服务器地址、房间码输入 + 创建/加入按钮 + 状态提示）；加入成功进入大厅层（房间码、座位列表、房主「开始游戏」、离开）。本任务只到大厅就座为止，下一任务接牌桌。

- [ ] **Step 1: 新增字段与 import**

import 追加：

```ts
import { NetClient } from '../net/NetClient';
import { clearOnlineCredentials, loadOnlineCredentials, resolveServerUrl, saveOnlineCredentials } from '../net/OnlineCredentials';
import { OnlineSession, TableUpdate } from '../net/OnlineSession';
import { RoomStateMessage } from '../net/protocol';
```

类字段追加：

```ts
  private onlineLayer!: Node;
  private onlinePanel!: Node;
  private onlineNicknameInput!: EditBox;
  private onlineServerInput!: EditBox;
  private onlineRoomCodeInput!: EditBox;
  private onlineStatusLabel!: Label;
  private lobbyLayer!: Node;
  private lobbyCodeLabel!: Label;
  private lobbySeatLabels: Label[] = [];
  private lobbyStartButton!: Node;
  private lobbyStatusLabel!: Label;
  private online: OnlineSession | null = null;
  private onlineClient: NetClient | null = null;
  private onlinePlayerId = '';
```

- [ ] **Step 2: 首页加「联机对战」按钮**

`buildHome` 中：

- `'开始游戏'` 按钮文案改为 `'单机游戏'`，位置 `0, -12` 不变；
- 在其下方加联机按钮：

```ts
    this.createTextButton(hero, 'home-online', '联机对战', 0, -86, 320, rgb(47, 95, 142), () => this.openOnlineSetup(), 42);
```

原 `'home-rules'`、`'home-settings'` 两个按钮 y 从 `-86` 改为 `-140`，底部说明文字 y 从 `-152` 改为 `-192`（`hero` 高度 430，布局不溢出）。

`openHomeModal`/`renderHome` 不变。

- [ ] **Step 3: 联机面板与大厅层构建方法**

`onLoad` 中 `this.buildHome();` 之后追加：

```ts
    this.buildOnlineSetup();
    this.buildLobby();
    this.onlineLayer.active = false;
    this.lobbyLayer.active = false;
```

新增方法（全部复用现有 `createRounded`/`createLabel`/`createTextButton`/`createParagraph` 帮手）：

```ts
  private buildOnlineSetup(): void {
    this.onlineLayer = this.createModalLayer('online-layer');
    this.onlinePanel = this.createRounded('online-panel', this.onlineLayer, 0, 0, 620, 470, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(this.onlinePanel, '联机对战', 0, 190, 25, GOLD);

    this.createLabel(this.onlinePanel, '昵称', -238, 138, 15, TEXT);
    this.onlineNicknameInput = this.createInput(this.onlinePanel, 'online-nickname', 42, 138, 360, '输入昵称（1-12 字）');
    this.createLabel(this.onlinePanel, '服务器', -238, 82, 15, TEXT);
    this.onlineServerInput = this.createInput(this.onlinePanel, 'online-server', 42, 82, 360, 'ws:// 或 wss:// 地址');
    this.createLabel(this.onlinePanel, '房间码', -238, 26, 15, TEXT);
    this.onlineRoomCodeInput = this.createInput(this.onlinePanel, 'online-room-code', 42, 26, 360, '加入时填写 4 位房间码');

    this.onlineStatusLabel = this.createLabel(this.onlinePanel, '', 0, -26, 14, rgb(228, 120, 120));
    this.createTextButton(this.onlinePanel, 'online-create', '创建房间', -130, -88, 200, rgb(28, 132, 92), () => void this.connectOnline('create'), 44);
    this.createTextButton(this.onlinePanel, 'online-join', '加入房间', 130, -88, 200, rgb(47, 95, 142), () => void this.connectOnline('join'), 44);
    this.createTextButton(this.onlinePanel, 'online-back', '返回', 0, -172, 180, rgb(117, 61, 70), () => this.closeOnlineSetup(), 42);
  }

  private createInput(parent: Node, name: string, x: number, y: number, width: number, placeholder: string): EditBox {
    const frame = this.createRounded(name, parent, x, y, width, 38, 8, rgb(14, 31, 52));
    const inputNode = new Node(`${name}-control`);
    inputNode.parent = frame;
    inputNode.addComponent(UITransform).setContentSize(width, 38);
    const inputLabel = this.createLabel(inputNode, '', 0, 0, 16, TEXT);
    const input = inputNode.addComponent(EditBox);
    input.inputMode = EditBox.InputMode.ANY;
    input.placeholder = placeholder;
    input.textLabel = inputLabel;
    return input;
  }

  private buildLobby(): void {
    this.lobbyLayer = new Node('lobby-layer');
    this.node.addChild(this.lobbyLayer);
    this.lobbyLayer.addComponent(UITransform).setContentSize(POKER_UI.canvas.width, POKER_UI.canvas.height);
    this.createRounded('lobby-background', this.lobbyLayer, 0, 0, POKER_UI.canvas.width, POKER_UI.canvas.height, 0, BACKGROUND);
    const panel = this.createRounded('lobby-panel', this.lobbyLayer, 0, 0, 620, 480, POKER_UI.radii.panel, PANEL_RAISED, GOLD, 1);
    this.createLabel(panel, '房间大厅', 0, 196, 25, GOLD);
    this.lobbyCodeLabel = this.createLabel(panel, '房间码 ----', 0, 152, 22, TEXT);

    for (let index = 0; index < 6; index += 1) {
      const row = this.createRounded(`lobby-seat-${index}`, panel, 0, 100 - index * 40, 440, 32, 8, rgb(25, 66, 76));
      this.lobbySeatLabels.push(this.createLabel(row, '空位', 0, 0, 15, TEXT));
    }

    this.lobbyStatusLabel = this.createLabel(panel, '', 0, -148, 14, rgb(139, 166, 190));
    this.lobbyStartButton = this.createTextButton(panel, 'lobby-start', '开始游戏', -110, -196, 200, rgb(28, 132, 92), () => this.online?.sendStartGame(), 44);
    this.createTextButton(panel, 'lobby-leave', '离开房间', 110, -196, 200, rgb(117, 61, 70), () => this.leaveOnline(), 44);
  }
```

注意 `createModalLayer` 目前把层挂到 `homeLayer` 下——联机面板也属于首页流程，同样挂 `homeLayer` 即可（与 rules/settings 一致）。

- [ ] **Step 4: 面板开合与连接逻辑**

新增方法：

```ts
  private openOnlineSetup(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'open-online' });
    const stored = loadOnlineCredentials(sys.localStorage);
    this.onlineNicknameInput.string = stored?.nickname ?? '';
    this.onlineServerInput.string = resolveServerUrl(sys.localStorage, sys.isBrowser ? window.location.search : '');
    this.onlineRoomCodeInput.string = stored?.roomCode ?? '';
    this.onlineStatusLabel.string = '';
    this.renderHome();
  }

  private closeOnlineSetup(): void {
    this.flow = reduceHomeFlow(this.flow, { type: 'close-online' });
    this.renderHome();
  }

  private async connectOnline(mode: 'create' | 'join'): Promise<void> {
    const nickname = this.onlineNicknameInput.string.trim();
    const serverUrl = this.onlineServerInput.string.trim();
    const roomCode = this.onlineRoomCodeInput.string.trim().toUpperCase();

    if (!nickname) {
      this.onlineStatusLabel.string = '请填写昵称';
      return;
    }

    if (!serverUrl) {
      this.onlineStatusLabel.string = '请填写服务器地址';
      return;
    }

    if (mode === 'join' && !roomCode) {
      this.onlineStatusLabel.string = '请填写房间码';
      return;
    }

    this.onlineStatusLabel.string = '正在连接服务器…';
    const client = new NetClient(serverUrl);

    client.onMessage = (message) => {
      if (message.type === 'joined') {
        this.onlinePlayerId = message.playerId;
        saveOnlineCredentials(sys.localStorage, { roomCode: message.roomCode, token: message.token, nickname, serverUrl });
        this.onlineClient = client;
        this.online = new OnlineSession(client, {
          playerId: message.playerId,
          credentials: { roomCode: message.roomCode, token: message.token, nickname, serverUrl },
          handlers: {
            onTableUpdate: (update) => this.applyTableUpdate(update),
            onRoomState: (room) => this.renderLobby(room),
            onSessionLost: (text) => this.handleSessionLost(text),
          },
        });
        this.flow = reduceHomeFlow(this.flow, { type: 'entered-lobby' });
        this.renderLobby(message.room);
        this.renderHome();
      } else if (message.type === 'error') {
        this.onlineStatusLabel.string = message.message;
      }
    };
    client.onClose = () => {
      if (this.flow.screen === 'online-setup') {
        this.onlineStatusLabel.string = '连接已断开';
      }
    };

    try {
      await client.connect();
    } catch {
      this.onlineStatusLabel.string = '无法连接服务器（若刚部署，可能在冷启动，请稍候重试）';
      return;
    }

    client.send(mode === 'create' ? { type: 'createRoom', nickname } : { type: 'joinRoom', roomCode, nickname });
  }

  private renderLobby(room: RoomStateMessage): void {
    this.lobbyCodeLabel.string = `房间码 ${room.code}`;

    for (let index = 0; index < this.lobbySeatLabels.length; index += 1) {
      const seat = room.seats[index];
      this.lobbySeatLabels[index].string = seat
        ? `${seat.nickname}${seat.playerId === room.hostId ? ' · 房主' : ''}${seat.connected ? '' : ' · 离线'}`
        : '空位';
    }

    const isHost = room.hostId === this.onlinePlayerId;
    this.lobbyStartButton.active = isHost && room.phase === 'lobby';
    this.lobbyStatusLabel.string = room.phase === 'playing'
      ? '牌局进行中…'
      : isHost ? '至少 2 人即可开始' : '等待房主开始…';
  }

  private leaveOnline(): void {
    this.online?.sendLeave();
    this.online = null;
    this.onlineClient = null;
    clearOnlineCredentials(sys.localStorage);
    this.flow = reduceHomeFlow(this.flow, { type: 'leave-lobby' });
    this.renderHome();
  }

  private applyTableUpdate(update: TableUpdate): Promise<void> {
    // Task 13 实现牌桌接线
    void update;
    return Promise.resolve();
  }

  private handleSessionLost(text: string): void {
    this.lobbyStatusLabel.string = text;
  }
```

`renderHome` 追加两行（控制两层显隐）：

```ts
    this.onlineLayer.active = this.flow.screen === 'online-setup';
    this.lobbyLayer.active = this.flow.screen === 'online-lobby';
```

`leaveOnline` 在 `renderHome` 把 `lobbyLayer` 隐藏的同时，首页层仍保持 `active`，所以无需额外操作。

- [ ] **Step 5: 验证**

Run: `pnpm run typecheck:game && pnpm test`
Expected: typecheck 无错误；测试全绿

手动验证（需要本地服务器）：

```bash
pnpm --dir server dev
```

Cocos Creator 预览 → 联机对战 → 服务器填 `ws://localhost:2567` → 创建房间，应进入大厅显示房间码与 1 个座位；再开一个浏览器标签打开 `site/index.html?server=ws://localhost:2567`（或第二个预览）加入同一房间码，两边大厅都应显示 2 个座位。

- [ ] **Step 6: Commit**

```bash
git add assets/scripts/bootstrap/GameBootstrap.ts
git commit -m "Add online setup panel and room lobby UI"
```

---

### Task 13: GameBootstrap 联机牌桌接线

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts`

把 `OnlineSession` 的 `TableUpdate` 接到既有的 `playEvents`/`render` 管线：服务器 `handStart` 把玩家从大厅带入牌桌；本地行动经 `sendAction` 发给服务器，以服务器广播回来为准播放动画；返回首页时离房清理。

- [ ] **Step 1: 模式字段与快照来源**

类字段追加：

```ts
  private mode: 'solo' | 'online' = 'solo';
  private onlineSnapshot: EngineSnapshot | null = null;
```

新增私有方法：

```ts
  private currentSnapshot(): EngineSnapshot {
    if (this.mode === 'online' && this.onlineSnapshot) {
      return this.onlineSnapshot;
    }

    return this.engine.snapshot();
  }
```

`getRaiseBounds` 首行 `const state = this.engine.snapshot();` 改为 `const state = this.currentSnapshot();`。

- [ ] **Step 2: 行动路由**

`handlePlayerAction` 替换为：

```ts
  private async handlePlayerAction(action: PlayerAction): Promise<void> {
    const token = this.activeSessionToken;
    if (this.busy || !this.sessions.isCurrent(token) || this.currentSnapshot().actingPlayerId !== 'player') {
      return;
    }

    if (this.mode === 'online') {
      this.online?.sendAction(action);
      this.renderActionButtons([]);
      return;
    }

    this.busy = true;
    const events = this.engine.act(action);
    await this.playEvents(events, token);
    if (!this.sessions.isCurrent(token)) {
      return;
    }
    this.busy = false;
    this.render(this.engine.snapshot());
    await this.runAiTurns(token);
  }
```

联机模式下本地行动不立刻播放动画——服务器广播 `actionTaken` 回来后经 `applyTableUpdate` 播放，自己的动作与其他玩家走同一条路径。

- [ ] **Step 3: `applyTableUpdate` 实现**

把 Task 12 的占位替换为：

```ts
  private applyTableUpdate(update: TableUpdate): Promise<void> {
    return this.runTableUpdate(update);
  }

  private async runTableUpdate(update: TableUpdate): Promise<void> {
    if (this.flow.screen === 'online-lobby' || this.flow.screen === 'online-setup') {
      this.enterOnlineTable();
    }

    if (this.flow.screen !== 'playing' || this.mode !== 'online') {
      return;
    }

    const token = this.activeSessionToken;

    if (update.newHand) {
      this.resetVisuals();
    }

    this.busy = true;
    await this.playEvents(update.events, token);

    if (!this.sessions.isCurrent(token)) {
      return;
    }

    if (update.snapshot) {
      this.onlineSnapshot = update.snapshot;
    }

    this.busy = false;

    if (this.onlineSnapshot) {
      this.render(this.onlineSnapshot);
    }
  }

  private enterOnlineTable(): void {
    this.mode = 'online';
    this.flow = reduceHomeFlow(this.flow, { type: 'online-game-start' });
    this.homeLayer.active = false;
    this.lobbyLayer.active = false;
    this.tableLayer.active = true;
    this.activeSessionToken = this.sessions.begin();
    this.applyOnlineSeats();
    this.resetVisuals();
  }

  private applyOnlineSeats(): void {
    const names = this.online?.seatNames() ?? new Map<string, string>();

    this.seats.forEach((seat, id) => {
      const name = names.get(id);
      seat.node.active = name !== undefined;
      if (name !== undefined) {
        seat.name.string = name;
      }
    });
  }
```

`TableUpdate` 已在 Task 12 随 `OnlineSession` 一起 import，无需再改 import。

每次 `renderLobby` 收到 `roomState`（座位变动）时，若已在牌桌也同步座位显隐与昵称——`renderLobby` 末尾追加：

```ts
    if (this.mode === 'online' && this.flow.screen === 'playing') {
      this.applyOnlineSeats();
    }
```

- [ ] **Step 4: 单机/联机切换与清理**

`requestStart`（单机入口）中 `this.engine = PokerEngine.createSixSeat();` 一行之前追加：

```ts
        this.mode = 'solo';
        this.onlineSnapshot = null;
        this.restoreSoloSeats();
```

新增方法：

```ts
  private restoreSoloSeats(): void {
    for (const { id, name } of getPokerSeatLayout()) {
      const seat = this.seats.get(id)!;
      seat.node.active = true;
      seat.name.string = name;
    }
  }
```

`completeReturnHome` 中 `this.engine = PokerEngine.createSixSeat();` 一行之前追加：

```ts
    if (this.mode === 'online') {
      this.online?.sendLeave();
      this.online = null;
      this.onlineClient = null;
      clearOnlineCredentials(sys.localStorage);
    }
    this.mode = 'solo';
    this.onlineSnapshot = null;
    this.restoreSoloSeats();
```

`handleSessionLost` 替换为（断线回大厅提示；若牌局中断线且重连失败，返回首页）：

```ts
  private handleSessionLost(text: string): void {
    if (this.flow.screen === 'playing') {
      this.completeReturnHome();
      return;
    }

    this.lobbyStatusLabel.string = text;
  }
```

大厅 `leaveOnline` 在 `playing` 中不会被点到（大厅层已隐藏），无需处理。

- [ ] **Step 5: 验证**

Run: `pnpm run typecheck:game && pnpm test`
Expected: typecheck 无错误；测试全绿

手动端到端（关键验收）：

```bash
pnpm --dir server dev
```

1. Cocos 预览联机创建房间；浏览器开 `site/index.html?server=ws://localhost:2567` 加入（浏览器版需为最新构建，或开两个 Cocos 预览）。
2. 房主点开始：两边进入牌桌，各自看到自己的两张手牌，对方显示背面。
3. 轮换行动（含加注、全压），动画、底池、合法按钮与单机一致；摊牌亮牌、结算正确；5 秒后自动开下一手，庄家轮换。
4. 一方关标签页：另一方看到其座位离线；60 秒内重连（重新加入同房间码由令牌恢复，或刷新页面重进）能回到牌桌。
5. 返回首页：单机模式仍可正常游戏（座位昵称恢复 AI 名单）。

- [ ] **Step 6: Commit**

```bash
git add assets/scripts/bootstrap/GameBootstrap.ts
git commit -m "Wire online session into the poker table"
```

---

### Task 14: 文档、脚本与部署说明

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 增加联机章节**

在「规则测试」一节之后插入：

````markdown
## 联机对战

`server/` 是权威联机服务器（Node + ws）：建房、发牌、行动校验与结算都在服务端执行，手牌只发给本人。

本地运行：

```bash
pnpm install
cd server && pnpm install   # 生成 server/pnpm-lock.yaml（首次）
cd ..
pnpm --dir server dev       # 默认监听 ws://localhost:2567
```

客户端连接：首页 → 联机对战 → 填写昵称、服务器地址（本地开发填 `ws://localhost:2567`）→ 创建或加入房间。也可以用 URL 参数指定服务器，如 `?server=ws://localhost:2567`（优先级高于页面填写与本地存储）。

部署（Render 免费档）：

1. 推送本仓库后，在 Render 新建 Web Service，Root Directory 填 `server`。
2. Build Command：`pnpm install`；Start Command：`pnpm start`。
3. 部署后得到 `wss://<服务名>.onrender.com`，客户端服务器地址填它（GitHub Pages 的 HTTPS 页面只能用 `wss://`）。
4. 免费档空闲约 15 分钟休眠，首个连接冷启动约 30–60 秒，客户端会提示稍后重试。

游客制：昵称即身份，令牌保存在浏览器 localStorage 用于断线重连（60 秒窗口）；房间不持久化，服务器重启即清空。行动超时 30 秒自动过牌/弃牌。
````

「结构」一节追加：

```markdown
- `server/`：联机服务器（房间管理 + 权威牌局裁决）。
- `assets/scripts/net`：协议类型、WebSocket 客户端与联机会话。
```

- [ ] **Step 2: 全量验证**

Run: `pnpm test && pnpm run typecheck:game && pnpm run typecheck:server`
Expected: 测试全绿；两个 typecheck 均无错误

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document multiplayer setup and deployment"
```

---

## 部署后事项（不在本计划代码任务内）

- Render 部署服务器，验证 `wss://` 可达。
- 如需让 Pages 站点默认直连服务器，把 `protocol.ts` 的 `DEFAULT_SERVER_URL` 改成部署地址（或用 `?server=` 参数），重新构建 Web Desktop 包替换 `site/`。
- 现有 `.github/workflows/pages.yml` 无需改动（纯静态前端）。
