# 多人联机对战设计

日期：2026-10-10

## 目标

在现有六人德州扑克单机版基础上，新增好友私房联机对战：

- 创建房间生成 4 位房间码，朋友凭房间码加入。
- 2–6 名真人短桌，不使用 AI 补位。
- 游客昵称制：进房间输入昵称即可玩，无注册登录；入座时筹码从固定初始值开始，房间内跨手牌延续，离开即清空。
- 单机模式（打 AI）保留，首页改为「单机游戏 / 联机对战」两个入口。

## 总体架构：服务器权威

新增一个常驻 Node WebSocket 服务器。服务器持有所有房间的 `PokerEngine` 实例，洗牌、行动校验、结算全部在服务端执行；手牌只发给对应玩家本人，客户端永远拿不到别人的牌。

```
浏览器客户端 (GitHub Pages, Cocos Web)  ──wss──>  Node 服务器 (Render)
                                                   ├── RoomManager：房间生命周期
                                                   └── PokerEngine 实例 × N 房间
```

现有 `assets/scripts/core/`（`PokerEngine`、`Deck`、`HandEvaluator`、`SidePot`）是纯 TypeScript、无 Cocos 依赖，直接由服务器复用，规则只有一份实现，现有测试全部继续有效。

选择此方案而非房主主机（P2P）：扑克中房主能看牌、操纵发牌是硬伤；房主掉线全桌散。不引入 Colyseus 等框架：用 `ws` 写一个薄服务器即可，框架的状态同步模型与扑克「按人发私有牌」的需求不匹配。

## 引擎改造（小）

- `PokerEngine` 新增静态工厂 `createWithPlayers(players: { id: string; name: string }[], options?)`，支持 2–6 人动态入座。座位顺序即传入顺序。
- 现有 `createSixSeat` 保留给单机模式，行为不变。
- 引擎现有的 `startHand()` / `act()` / `snapshot()` / `takeEvents()` / `getHoleCards(playerId)` 接口不变，服务器直接驱动。
- 确认 2 人局盲注规则（heads-up：庄家位下小盲）在引擎中正确处理，如未处理则补上。

## 服务器（`server/` 目录）

独立 `package.json`（Node + TypeScript + `ws`），通过相对路径或 workspace 引用 `assets/scripts/core`。

### RoomManager

- 房间码：4 位字母数字（去除易混淆字符 0/O、1/I），创建时校验唯一。
- 房间状态：`lobby`（等待开局，可加入/离开）→ `playing`（连续手牌，筹码延续）。`playing` 中新玩家仍可加入并入座，从下一手开始参与发牌，等待期间仅看到牌桌公共状态（无独立观战界面）。
- 房主：创建者为房主，只有房主能 `startGame`（要求 ≥2 人）。房主离开则移交给座位列表下一位。
- 房间不持久化，服务器重启即清空（游客制下可接受）。

### 消息协议（JSON over WebSocket）

客户端 → 服务器：

| 消息 | 载荷 | 说明 |
|---|---|---|
| `createRoom` | `{ nickname }` | 创建房间，返回房间码与重连令牌 |
| `joinRoom` | `{ roomCode, nickname }` | 加入房间，返回重连令牌 |
| `reconnect` | `{ roomCode, token }` | 断线重连，恢复座位 |
| `leaveRoom` | — | 离开房间 |
| `startGame` | — | 房主开始第一手 |
| `action` | `PlayerAction` | 出牌动作（复用 `core/types.ts` 的 `PlayerAction` 类型） |

服务器 → 客户端：

| 消息 | 载荷 | 说明 |
|---|---|---|
| `roomState` | 房间快照：房间码、座位列表（昵称、筹码、是否房主、是否连接中）、阶段 | 大厅与牌桌通用，有人变动即广播 |
| `handStart` | `{ handId, dealerSeat, stacks }` | 广播一手开始 |
| `yourHand` | `{ cards: Card[] }` | **私有**，仅发给本人 |
| `stateSync` | `{ street, pot, communityCards, actingPlayerId, legalActions, players }` | 公共状态，源自 `EngineSnapshot`（不含他人手牌） |
| `actionTaken` | `{ playerId, action, amount }` | 任何行动后广播 |
| `showdown` | `{ reveals: { playerId, cards, handName }[] }` | 仅在真正摊牌时亮牌；提前收池不亮弃牌者的牌 |
| `handResult` | `{ payouts: { playerId, amount, handName }[] }` | 结算与最新筹码 |
| `error` | `{ code, message }` | 如 `room-not-found`、`room-full`、`not-your-turn`、`illegal-action` |

### 行动与超时

- 服务器收到 `action` 后校验：是否在 `playing`、是否轮到该玩家、动作是否在 `legalActions` 内。非法一律 `error` 拒绝，不改动牌局。
- 行动超时 30 秒：若 `check` 合法则自动过牌，否则自动弃牌。超时值定义为常量，便于调整。
- 一手结束（`settled`）后广播 `handResult`，停顿约 5 秒自动开始下一手；只剩 1 名玩家则回到 `lobby`。

### 断线与重连

- 加入/创建房间时服务器签发随机令牌（token），客户端存 `localStorage`。
- 断线后座位保留 60 秒，`reconnect` 带令牌恢复；期间该玩家若轮到自己行动，超时计时照常进行。
- 超过 60 秒未重连：移除座位；若在一手牌中则视为弃牌。筹码清零。

## 客户端改造

- 新增 `assets/scripts/net/NetClient.ts`：连接管理、消息编解码、心跳、断线自动重连（指数退避，带令牌）。
- 新增大厅界面：创建房间（输入昵称）/ 加入房间（输入昵称 + 房间码）/ 等待房间（显示座位、房主有开始按钮）。风格沿用 `PokerUiTheme`。
- `GameBootstrap.ts` 抽象「行动来源」：
  - 单机：本地动作直接进引擎，AI 动作由 `AiController` 产生（现状）。
  - 联机：本地动作经 `NetClient` 发给服务器；所有动作（含自己的）以服务器广播为准驱动 UI 动画。桌面渲染、动画、音效代码基本复用。
- 首页增加「联机对战」入口，服务器地址做成可配置项（首页设置项 + URL 参数 `?server=wss://...`），默认指向部署后的地址。

## 部署

- 推荐 **Render 免费档**：原生支持 WebSocket、自带 TLS（GitHub Pages 的 HTTPS 页面必须连 `wss://`）、从 GitHub 仓库一键部署。
- 已知取舍：免费档空闲约 15 分钟休眠，首个连接冷启动约 30–60 秒。好友约局场景可接受；客户端连接时显示「正在唤醒服务器」提示。
- 仓库保持单仓双包：`server/` 独立部署到 Render；前端继续由 `.github/workflows/pages.yml` 部署 `site/` 到 GitHub Pages。
- 将来迁移 Railway/Fly.io 等只改客户端服务器地址配置，不改代码。

## 错误处理汇总

- 房间不存在 / 已满 / 昵称重复：加入时返回 `error`，客户端提示。
- 连接断开：大厅中直接提示并允许重进；牌局中按上述 60 秒重连窗口处理。
- 服务器重启：所有房间消失，客户端收到断开提示返回首页。

## 测试策略

- 现有 vitest 核心与 AI 测试保持全绿，`createSixSeat` 路径不回归。
- 新增 `tests/net/` 集成测试：vitest 内起真实 WebSocket 服务器 + 模拟 2–6 个客户端，覆盖：
  - 建房、加入、房间码冲突、满员拒绝；
  - 2 人与 6 人各打完整一手牌（含边池）；
  - 私有手牌不泄露（客户端收不到他人 `yourHand`）；
  - 非法行动（非回合、金额越界）被拒绝；
  - 断线 60 秒内重连恢复、超时移除座位；
  - 行动超时自动过牌/弃牌。
- `pnpm run typecheck:game` 扩展覆盖 `server/` 与新增客户端代码。

## 明确不做（YAGNI）

- 账号体系、筹码持久化、排行榜。
- 随机匹配、独立观战模式、聊天。
- AI 补位（联机模式纯真人）。
- 房间持久化与服务器重启恢复。
