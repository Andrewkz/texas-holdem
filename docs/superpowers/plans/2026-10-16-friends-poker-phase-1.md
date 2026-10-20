# 第一阶段：顺畅约局实施计划

> 2026-10-17 验收调整：用户明确要求“直接在浏览器做校验即可”。第一阶段改以实际编译包的浏览器流程与手机视口模拟验收，真实设备不再阻塞；执行状态以 `openspec/changes/friends-poker-phase-1/tasks.md` 为准，模拟范围见验收报告。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 2–6 名朋友在手机横屏浏览器通过邀请入桌，在刷新、短暂断线和中途加入后获得明确、正确的牌局状态。

**Architecture:** 保留 Cocos Creator 客户端、Node 单进程权威服务器和 WebSocket 协议。将邀请解析、入场恢复决策、连接状态与布局计算从 `GameBootstrap.ts` 提取为小模块；服务端负责座位身份、公共状态和计时，界面只呈现已确认的状态。先完成协议和恢复边界，再接线 UI，最后验证实际 Cocos 构建包。

**Tech Stack:** Cocos Creator 3.8.8、TypeScript、Node.js ≥22、ws、Vitest、Nginx、systemd。

**Spec:** `docs/superpowers/specs/2026-10-16-friends-poker-roadmap.md`。

## Global Constraints

- 纯虚拟筹码，联机仅 2–6 名真人；盲注固定 20 / 40，初始筹码 5,000。
- 手机浏览器横屏优先，同时兼容电脑；竖屏显示横屏提示。
- 断线保留座位 3 分钟；行动超时 30 秒，能过牌则过牌，否则弃牌；恢复连接不重置行动计时。
- 中途加入只参与下一手；满 6 人提示房间已满，不开放旁观入口。
- 邀请链接不携带恢复令牌，不携带用户本地保存的自定义服务器地址；恢复令牌不写入日志。
- 第一阶段不宣称具备筹码账本、整场结算、30 天分享页或服务重启恢复；这些按路线图后续阶段交付。
- 当前工作树包含已完成的 UI、部署和技能安装变更。执行前核对差异，不覆盖、回滚或顺带提交无关改动。
- 本文件是已确认路线图的任务拆分；本次仅保存文档，开发和生产发布均不在本次执行范围。

---

## 1. 执行顺序与文件责任

| 任务 | 交付 | 主要文件 | 依赖 |
|---|---|---|---|
| P1-01 | 邀请链接与入场目标解析 | 新建 `assets/scripts/net/RoomInvite.ts`、`tests/net/RoomInvite.spec.ts` | 无 |
| P1-02 | 3 分钟保座与中途入桌状态 | `protocol.ts`、`Room.ts`、`RoomManager.ts`、对应测试 | 无 |
| P1-03 | 页面启动恢复与连接状态 | 新建 `OnlineEntry.ts`、`OnlineEntry.spec.ts`；修改 `OnlineSession.ts`、`OnlineCredentials.ts` | P1-01、P1-02 |
| P1-04 | 入场、等待、恢复界面接线 | `HomeFlow.ts`、`GameBootstrap.ts`、`tests/ui/HomeFlow.spec.ts` | P1-03 |
| P1-05 | 手机横屏布局与输入 | 新建 `PokerViewport.ts`、`tests/ui/PokerViewport.spec.ts`；修改主题、Bootstrap、网页模板 | P1-04 |
| P1-06 | 完整构建、多人验收与交付记录 | README、`site/` 构建产物 | P1-01 至 P1-05 |

新增 `assets/` 脚本同时生成符合现有格式的 `.meta`。任务 P1-01 和 P1-02 可以独立实现；同一文件的改动串行合并，避免并行修改 `GameBootstrap.ts`。

## 2. 共用契约

以下是建议的阶段内接口，实施时若更改命名，应同步更新所有消费处和测试，不能保留两个含义不同的同名状态。

### 2.1 邀请与恢复

```ts
// assets/scripts/net/RoomInvite.ts
export interface InviteTarget { roomCode: string }
export function parseRoomInvite(search: string): InviteTarget | null;
export function createRoomInvite(pageUrl: string, roomCode: string): string;

// assets/scripts/net/OnlineEntry.ts
import { OnlineCredentials } from './OnlineCredentials';
import { InviteTarget } from './RoomInvite';
export type EntryIntent =
  | { kind: 'resume'; credentials: OnlineCredentials }
  | { kind: 'join'; roomCode: string }
  | { kind: 'setup' };
export function chooseEntryIntent(
  invite: InviteTarget | null,
  stored: OnlineCredentials | null,
  targetServerUrl: string,
): EntryIntent;
```

有效邀请的目标服务器先按邀请页面的部署配置/同源 `/ws` 确定，不采用旧的已保存自定义 endpoint 或链接外的服务器覆盖参数；随后才检查保存凭证是否属于该目标。普通无邀请联机入口保留原地址选择规则。本地开发邀请可使用本机既有 2567 默认；需要自定义后端却无法从站点部署配置确定目标时，明确提示不支持该邀请，不悄悄连接另一服务器。

邀请 URL 使用同一站点路径的 `?room=AB23`，保留站点前缀，去掉旧查询参数和 fragment；不把当前 `?server=`、token、昵称或其他存储内容复制到邀请链接。房间码 trim/转大写后按现有 4 位字符表验证，使用 `split('')` 等 Cocos 可正确编译的写法。

恢复决策：

1. 有邀请且与已存房间码不同，显示该邀请的加入入口，不偷偷恢复另一个房间。
2. 目标服务器与保存凭证所属服务器不一致，不发送该凭证；显示加入/设置入口。
3. 同一服务器且没有冲突邀请，优先恢复原座位；不能用普通 `joinRoom` 代替恢复。
4. 恢复被拒绝时提示“原座位无法恢复，可重新加入”；由用户明确选择后再加入，不自动新增玩家或发放 5,000。
5. 断线与刷新保留凭证；主动离房或明确放弃旧座位后才清理对应凭证。

邀请码可以复用，不能当作永久会话身份。第一阶段通过 token 验证原座位，旧房间销毁后旧 token 必须失败。邀请链接的永久会话绑定、账本参与者身份延续在第二、三阶段与稳定会话 ID 一起落地；第一阶段不把昵称当成身份。

### 2.2 服务器牌桌状态

保留 `stateSync.snapshot: EngineSnapshot`，增加明确的本人参与状态：

```ts
// assets/scripts/net/protocol.ts
export type TableParticipation = 'playing-hand' | 'waiting-next-hand';
// stateSync 增加必填字段 participation: TableParticipation。
// handStart 增加 participantIds: string[]，在发牌后冻结为实际获发两张底牌的玩家 ID。
```

- `joined` 先发送；客户端在同步处理该消息时建立 `OnlineSession`、映射座位和接管后续消息。
- 进行中加入者收到公共快照，`participation='waiting-next-hand'`，`legalActions=[]`；不能收到本手 `yourHand`，也不能在客户端生成本人底牌。
- 正在参与本手的恢复玩家收到 `handStart`、本人的 `yourHand`、过滤后的 `stateSync`。
- `participantIds` 只包括本手实际获发牌玩家；引擎 snapshot.players 还可能包含零筹码未发牌座位，不能直接当成名单。名单在该手发牌时冻结，随后全压至零者仍属于该手。客户端不能按大厅所有座位生成本手背牌。
- 每一次 `stateSync`（包括行动后正常推送、加入与恢复）都按接收者产生 `participation` 与合法动作；等待者始终为空动作，其他人的合法动作也不能作为本人权限。不能只改补发路径而保留共享的未过滤广播。
- 第一阶段沿用服务器行动超时，不新增看似精确但没有服务器截止时间依据的倒计时。

### 2.3 客户端连接呈现

```ts
export type OnlineConnectionStatus =
  | 'connecting' | 'restoring' | 'connected'
  | 'reconnecting' | 'resume-unavailable' | 'session-taken-over';
```

`HomeFlow` 增加 `online-restoring` 画面状态，以及 `begin-online-restore`、`restore-failed`、`online-back-to-lobby` 事件；等待下一手属于牌桌参与状态，不伪装成可行动状态。旧标签页收到 `session-taken-over` 后停止自动重连，避免互相顶号。

## 3. 任务与验证

### P1-01：分享邀请与解析

**文件：** 新建 `assets/scripts/net/RoomInvite.ts`、对应 `.meta`、`tests/net/RoomInvite.spec.ts`。

- [ ] 写邀请链接与解析测试，至少覆盖下列断言及空值、错误长度、非法字符、大小写规范化。

```ts
expect(parseRoomInvite('?room=ab23')).toEqual({ roomCode: 'AB23' });
expect(parseRoomInvite('?room=AB0O')).toBeNull();
const link = createRoomInvite(
  'https://example.test/poker/?server=wss://other.test&token=secret#old', 'AB23',
);
expect(link).toBe('https://example.test/poker/?room=AB23');
```

- [ ] 运行 `pnpm test tests/net/RoomInvite.spec.ts`，确认因缺失目标行为而失败。
- [ ] 实现接口；无效生成参数应抛出可识别错误，由调用层呈现失败，不能生成错误邀请。
- [ ] 重新运行该测试并核对项目路径前缀、IP HTTP 与域名 HTTPS 生成结果。
- [ ] 完成独立审查；仅记录本任务的变更，后续经授权提交时按文件暂存。

### P1-02：服务端保座与等待下一手

**文件：** 修改 `assets/scripts/net/protocol.ts`、`server/src/Room.ts`、`server/src/RoomManager.ts`、`tests/net/protocol.spec.ts`、`tests/net/RoomLifecycle.spec.ts`、`tests/net/RoomHand.spec.ts`、`tests/net/RoomLobby.spec.ts`；更新构造协议消息的 `tests/net/fakes.ts` 与客户端测试夹具。

**产出：** `RECONNECT_WINDOW_MS = 180_000`；P1 共用协议；`RoomManager.joinRoom()` 在发送 `joined` 后补公共牌桌状态；`Room.resendHandState()` 区分本手参与者和等待者。

- [ ] 用现有 `connect/createRoom/joinRoom` 夹具及 Vitest 假时钟先补回归测试。

```ts
const manager = new RoomManager({ reconnectWindowMs: 180_000, actionTimeoutMs: 30_000 });
const a = createRoom(manager, 'Alice');
const b = joinRoom(manager, a.joined.roomCode, 'Bob');
manager.handleMessage(a.connection, { type: 'startGame' });
const late = joinRoom(manager, a.joined.roomCode, 'Cara');
expect(late.connection.last('stateSync')?.participation).toBe('waiting-next-hand');
expect(late.connection.last('stateSync')?.snapshot.legalActions).toEqual([]);
expect(late.connection.last('yourHand')).toBeUndefined();
manager.handleClose(b.connection);
vi.advanceTimersByTime(179_999);
const back = connect(manager);
manager.handleMessage(back, { type: 'reconnect', roomCode: a.joined.roomCode, token: b.joined.token });
expect(back.last('joined')?.playerId).toBe(b.joined.playerId);
```

- [ ] 另测 180,001 ms 后原 token 不能恢复；断线时 30 秒行动规则照常执行；恢复不延长已安排的行动计时；中途加入者从下一手才出现在 `participantIds`；零筹码未发牌者不在名单，本手已发牌后全压至零者仍在名单。第三人中途加入后，让其他人继续行动，逐次断言等待者的所有 `stateSync` 仍为空动作且保持等待状态。
- [ ] 运行 `pnpm test tests/net/RoomLifecycle.spec.ts tests/net/RoomHand.spec.ts tests/net/RoomLobby.spec.ts tests/net/protocol.spec.ts` 观察预期失败。
- [ ] 修改协议与状态补发顺序。公共快照不能包含未公开的其他手牌；保持底池、边池和庄家轮转算法不变。
- [ ] 修正房主主动离房的接任选择：优先剩余在线玩家；无在线候选时保留待移交状态，下一位恢复者接任。测试两种路径；不授予已离席或被移除玩家权限。
- [ ] 重跑上述测试及 `pnpm run typecheck:server`，审查重复 close、过期 timer、嵌套自动弃牌是否只创建一次下一手。

### P1-03：入场恢复控制与重连接管

**文件：** 新建 `assets/scripts/net/OnlineEntry.ts`、对应 `.meta`、`tests/net/OnlineEntry.spec.ts`；修改 `OnlineCredentials.ts`、`OnlineSession.ts`、`NetClient.ts`（仅在需要连接超时/取消能力时）、`tests/net/OnlineCredentials.spec.ts`、`tests/net/OnlineSession.spec.ts`、`tests/net/NetClient.spec.ts`。

- [ ] 先测 `chooseEntryIntent` 的同房恢复、不同邀请加入、不同服务器不泄露 token、无凭证设置入口。

```ts
const stored = { roomCode: 'AB23', token: 'private', nickname: 'A', serverUrl: 'ws://example.test/ws' };
expect(chooseEntryIntent(null, stored, stored.serverUrl)).toEqual({ kind: 'resume', credentials: stored });
expect(chooseEntryIntent({ roomCode: 'CD45' }, stored, stored.serverUrl)).toEqual({ kind: 'join', roomCode: 'CD45' });
expect(chooseEntryIntent(null, stored, 'ws://other.test/ws')).toEqual({ kind: 'setup' });
```

- [ ] 运行 `pnpm test tests/net/OnlineEntry.spec.ts tests/net/OnlineSession.spec.ts` 观察新增用例失败。
- [ ] 实现决策与连接状态通知。服务器地址比较使用 URL 规范化后的完整 WebSocket endpoint，不能只比较 hostname。无邀请入口保留已有 query > stored > 同源 `/ws` > 本机默认的地址选择优先级；有邀请入口先确定邀请站点目标，再读取存储凭证进行匹配，不能让存储 endpoint 改变邀请目标。新增“同源邀请 + 另一服务器保存凭证 + 相同房间码”测试，确认不泄露旧 token、不恢复旧服务器房间。
- [ ] 调整重连策略：有截止时间的重试覆盖 3 分钟窗口，单次连接和等待 `joined` 也要有有限超时；主动离房/被接管/取消恢复立即终止重试并清理 timer。网络未知时提示“正在重连”，不假定客户端时钟等于服务端剩余保座时间。
- [ ] 测试 `joined` 后同步接管 `handStart/yourHand/stateSync`，不丢底牌、不重复发牌、不对等待者合成牌；恢复失败不自动发送 `joinRoom/createRoom`。
- [ ] 重跑 `pnpm test tests/net/OnlineEntry.spec.ts tests/net/OnlineSession.spec.ts tests/net/NetClient.spec.ts tests/net/OnlineCredentials.spec.ts`；检查不同房间/不同标签页连接不会被旧异步回调覆盖。

### P1-04：把邀请、恢复和等待接到界面

**文件：** 修改 `assets/scripts/ui/HomeFlow.ts`、`tests/ui/HomeFlow.spec.ts`、`assets/scripts/bootstrap/GameBootstrap.ts`；复用前两项新增模块。

- [ ] 在 `HomeFlow.spec.ts` 添加 `home -> online-restoring -> online-lobby/playing`、恢复失败回在线设置、取消后过期成功回包不跳转、`playing -> online-lobby` 的状态断言，先运行并确认失败。
- [ ] 新启动页面在各 UI 层构建完成后解析邀请和恢复意图；邀请无凭证时直接显示已填房间码的昵称入场页，不能不经确认自动发放座位。
- [ ] 收到 `joined` 时同步创建并 prime `OnlineSession`，随后才播放转场。取消时关闭 pending client，恢复期间禁用重复提交；旧回包必须校验当前连接与会话代号。
- [ ] 大厅和牌桌加入“邀请好友”：优先使用浏览器原生分享；不可用/被取消时提供复制链接或可选中的链接文本。当前 IP HTTP 环境的剪贴板 API 可能不可用，必须验证可手动复制。
- [ ] 等待玩家看到公共牌与“已入座，下一手加入”，本人无本手牌、无行动按钮；人数不足回大厅时清理旧牌桌状态并正确跳转。
- [ ] 断线提示可持续显示；网络恢复、页面刷新和重新前台后复查服务端状态；错误文案区分房间不存在、已满、昵称冲突、座位失效、连接被接管，保留可返回入口。
- [ ] 重跑 `pnpm test tests/ui/HomeFlow.spec.ts`，浏览器实测有效链接、错误链接、刷新、取消恢复、无效令牌、重复点击、两标签页接管。

### P1-05：手机横屏可操作布局

**文件：** 新建 `assets/scripts/ui/PokerViewport.ts`、对应 `.meta`、`tests/ui/PokerViewport.spec.ts`；修改 `PokerUiTheme.ts`、`GameBootstrap.ts`、`build-templates/web-desktop/style.css`、`build-templates/web-desktop/index.ejs`。`site/` 只由最终构建更新。

**接口：** `getPokerViewport(width: number, height: number): { designWidth: number; designHeight: number; actionHeight: number; compact: boolean }`。输入为扣除安全区后的可用 CSS 像素，返回设计坐标；每次尺寸变化重新计算，监听与卸载成对。

- [ ] 先写纯计算测试：844×390、667×375、1280×720、1440×900，断言数值有限、无负尺寸、横屏主要动作实际触摸高度不小于 44 CSS px；竖屏不假装完成横屏可操作验收。
- [ ] 运行 `pnpm test tests/ui/PokerViewport.spec.ts` 观察新增用例失败。
- [ ] 以现有 1280×720 为桌面基准，手机横屏允许自适应逻辑高度/操作区；不能仅把网页固定 16:9 画布缩小就称为手机适配。设计高度、卡牌和座位坐标一起校正，保证公共牌、本人手牌与操作区不重叠。
- [ ] 重排高密度弹窗：昵称输入、加注输入、预设金额、确认与取消在键盘展开/收起后均能操作；超出空间时明确滚动，不能裁切确认按钮。
- [ ] 应用 safe-area、恢复/等待提示；保留桌面布局及竖屏引导。检查返回确认弹层和加注弹层拦截点击，禁用状态不触发行动。
- [ ] 重跑布局测试；在实际编译包浏览器手机横屏视口验证点击、原生输入、缩小可视区域、模拟安全区、页面冻结/恢复与网络恢复；记录浏览器版本、构建标识和模拟边界，不用模拟结果宣称真机已通过。

### P1-06：构建与阶段验收

**文件：** README 中的使用与阶段限制；Cocos 生成的 `site/`；测试证据保存在仓库外，记录访问地址/构建校验值/设备与结果。

- [ ] 运行以下检查，全部通过后进入可运行包验收。

```bash
pnpm run typecheck:game
pnpm run typecheck:server
pnpm test
```

- [ ] 通过现有 Cocos 3.8.8 Web Desktop 流程构建；确认日志中该次构建 `Finished`，不仅以 CLI 退出码判断。使用仓库 `build-templates/web-desktop/`，核对产物与源文件一致。
- [ ] 在独立本地端口服务构建包；真实点击 2 个独立会话建房/加入/开局，第三人中途加入；检查底牌隔离、`waiting-next-hand` 和实际下一手参与。
- [ ] 在构建包实测邀请码 `AB23`、含非连续字符的邀请码；检查 Cocos 字符串展开编译兼容性、原生 EditBox 生命周期和完整 `/ws` 地址未被默认长度截断。
- [ ] 对参与者刷新、断网/恢复、切后台、无效 token、超过 3 分钟、房主离房、人数不足回大厅分别留验收结果；自动测试用假时钟覆盖边界，至少一次真实设备验证保座窗口。
- [ ] 检查控制台错误和失败资源请求；桌面与手机截屏核对文字、座位、公共牌、按钮、弹窗与输入；本手已结算/等待下一手不能呈现可重复出牌按钮。
- [ ] 更新 README：列出第一阶段已完成项和仍在后续阶段的服务器重启恢复、筹码账本与整场结算，避免把路线图当作现有能力。
- [ ] 形成阶段验收结果后交付审阅。生产发布单独授权；发布时检查线上房间，说明重启会影响现有对局，保存旧版本，使用部署后双人烟测决定是否保留新版本。

## 4. 阶段出口与后续衔接

第一阶段通过条件：P1-01 至 P1-06 完成，邀请、刷新恢复、中途加入、3 分钟保座和手机横屏主流程均有证据；原单机模式和现有玩法测试不回归。不存在“单元测试通过即完成手机/多人验收”的替代条件。

以下能力不从第一阶段提前借用：

- 第二阶段建立稳定会话 ID、参与者账本和补码事件，离席与断线不能抹去本场记录。
- 第三阶段实现正式结束本场、全员离开/全员断线结束规则的持久结果，以及发牌前回滚边界。第一阶段仅清理内存房间，不向用户宣称已保存散场记录。
- 第四阶段提供结算分享与 30 天保留，并完成四阶段整体验收。

**当前执行状态：仅完成路线图和本计划的编写；所有实施复选框保持未勾选。**
