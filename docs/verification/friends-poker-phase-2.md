# 好友扑克第二阶段验收：整场账本与免费补码

日期：2026-10-17。对象：OpenSpec `friends-poker-session-lifecycle`，协议 v3，持久记录 schema v1。实际 Cocos Creator 3.8.8 构建于 17:30:56 完成；`build/web-desktop`、`site` 与浏览器实际读取的 `assets/main/index.js` SHA-256 为 `3f5dfffcd30209d2b868211a78c5000ba357f0bb7229f6c1e6ef8f6fb43fddfd`。

用户另行明确授权“部署上线”后，v3已于2026-10-17 17:48:34配套发布，并通过公网双人浏览器烟测；详见[生产发布记录](production-2026-10-17-session-v3.md)。本文仍区分本地故障验证与生产烟测。浏览器验收按用户授权执行，视口、键盘占用和安全区均为模拟，未声称真实手机、系统键盘或设备安全区验证。

最终全套 Vitest（`/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-all-vitest.json`）：436/436 通过；`pnpm typecheck:game` 与 `pnpm typecheck:server` 均退出 0（发布负责人最终重跑确认）。下列测试文件均包含在该全套结果中；不是把各次局部结果相加。

## 交付与路线图 M2 门槛

稳定 sessionId/playerId 与连接、座位、昵称分离；首次 5000、补码次数、累计投入、已离场归属与最终盈亏使用服务端账本。爆零补码须确认，在下一手发牌前生效；全压未结清不等于爆零。普通离座弃牌，全压离座保留主池/边池权益，待完整手结算再清算；同身份重入扣回同笔离场归属。

| M2 门槛 | 结果和证据 |
| --- | --- |
| 首次 5000 一次，刷新/重连/重入不重发 | 通过；L01–L03、B2/B6 |
| 爆零下一手补至 5000，一次投入及次数 | 通过；L04/L06，B2/B6 实际确认和下一手 |
| 非零及未结全压拒绝，当前底池不变 | 通过；L05，M 实际输入/取消不改资金 |
| 离开/重入/全压/边池归属一致 | 通过；L08–L12、固定牌引擎测试 |
| 多次补码、含离开者整场独立核对零和 | 通过；L15、WholeSessionLedger 四手手算 |

## 规格全部场景：15/15

| 场景 | 规格原名 | 验证与结果 |
| --- | --- | --- |
| L01 | 同身份跨连接恢复 | 通过；`OnlineCredentials`、`OnlineEntry`、`OnlineSession`、`SessionLifecycle`；B2/B6 刷新及断网恢复稳定 ID，无额外首次投入 |
| L02 | 主动离座后按原身份重入 | 通过；`SessionLedger`、`SessionLifecycle`；B2/B6 明确离座与重入，M 仅以专用身份测试 |
| L03 | 同码不同场或同昵称无证明 | 通过；`OnlineEntry.spec.ts`、`OnlineCredentials.spec.ts` 的完整 endpoint/session 匹配与旧证明隔离；`SessionLifecycle` 入场证明和负载冲突拒绝 |
| L04 | 合格玩家确认补码 | 通过；`SessionLedger`、`SessionLifecycle` 下一手原子生效；B2/B6 真实爆零、确认、下一手投入 10000/补码 1 |
| L05 | 全压不等于爆零 | 通过；`SessionLedger`、`SessionLifecycle` 未结权益与非零余额拒绝；`SessionPanels` eligibility；M 有余额入口禁用 |
| L06 | 重复或竞态补码 | 通过；`SessionLedger`、`OnlineCommands`、`SessionLifecycle` 原请求去重；B2/B6 双击只发一次；C 的 rebuy 四边界 |
| L07 | 补码尚未生效便离座 | 通过；`SessionLedger` 取消待补码，`SessionLifecycle` 离座/结束路径；不增加投入和次数 |
| L08 | 普通离座和全压离座 | 通过；`PokerEngineDeparture.spec.ts`、`SessionLifecycle` 普通乱序离座立即弃牌、全压权益保留；B6 普通离座后同身份重入 |
| L09 | 主池边池和平分 | 通过；`SessionLifecycle` 六人固定牌主池/边池/未匹配返还与平分；`SidePot.spec.ts`、`PokerEngine.spec.ts` 引擎回归 |
| L10 | 未结清便要求重入 | 通过；`SessionLifecycle` 拒绝 pending equity；`SessionPanels` 不展示暂估最终归属 |
| L11 | 反复离开与重入 | 通过；`SessionLedger` 多次归属转移与精确去重；`WholeSessionLedger` 离开/重入后独立手算 |
| L12 | 超过六名历史参与者 | 通过；`SessionLifecycle` 历史超过六行；B6 最终保留 7 位历史参与者，同时座位不超过六 |
| L13 | 提交成功后确认丢失 | 通过；`OnlineCommands` 原 ID 重试/查询；`SessionLifecycle` 提交后回执；C 的 leave/rejoin/rebuy/end 旧/新完整版本 |
| L14 | 持久提交失败 | 通过；`MatchStore`、`SessionLifecycle` storage-failed 暂停；rename 后不确定回执不得谎报未提交；`OnlineSession` 禁止继续出牌 |
| L15 | 多手多次补码和离开者 | 通过；`WholeSessionLedger` 四手、两次补码、离座重入与历史离开者独立手算；B2/B6 最终零和 |

## 独立手算

`tests/session/WholeSessionLedger.spec.ts` 使用确定的完整手结果，独立于引擎派奖计算验证账本。A 首次 5000、补码两次共投入 15000，离开再带回 4000不算新投入，最终 7000，净 −8000；B 投入5000、离开归属11000，净 +6000；C 投入5000、最终7000，净 +2000。归属总额25000等于累计投入，净值合计0。持久模型恢复后用真实 RoomManager 结束与重复结束，再核对固定公开结算。

这项确定性账本测试与六人固定牌主池/边池测试、实际浏览器整场互补，不将合成完整手输入冒称真实发牌流程。

## 证据索引

| 编号 | 证据 |
| --- | --- |
| A | `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-all-vitest.json`；436/436，包含 `tests/session/WholeSessionLedger.spec.ts` |
| C | `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-crash-vitest.json`、`/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-crash-evidence.json`；真实独立进程 SIGKILL 27/27 |
| B2 | `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/full-2/results.json`；两人实际编译包完整流程16项成功；脱敏增强轨迹 |
| B6 | `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/full-6/results.json`；六人实际编译包完整流程18项成功；脱敏增强轨迹 |
| M | `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/mobile/report.json`、`/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-mobile-browser.log`；38 项通过，27 张截图 |
| S | `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/public-share/results.json`；独立分享专项 6 项通过 |

B2/B6 最终结果包含脱敏 `peerTraces`（两人3个、六人7个历史页面身份）和 `committedServerProjection`（各1场）。轨迹逐页保存实际主包200/SHA、管理请求ID和回执、当前手公共状态、回退代号及账本；恢复证明原值和私牌内容被省略，记录省略数量。服务端提交投影移除凭证校验秘密，保留账本事件、命令回执、检查点和最终结算供交叉核对。两条最终运行均 `temporaryDataRemoved=true`。B2/B6/S同时保留浏览器版本、URL、错误/失败资源与清理结果；M保留各控件CSS几何。复核时使用原始证据，不将本文表格代替运行记录。最终原始证据已归档到上述持久目录；早期失败脚本尝试留在/tmp，不作为通过证据。
