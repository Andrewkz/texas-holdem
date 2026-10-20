# 好友扑克第三阶段验收：完整手结束与持久恢复

日期：2026-10-17。对象：OpenSpec `friends-poker-session-lifecycle`，协议 v3，持久记录 schema v1。实际 Cocos Creator 3.8.8 构建于 17:30:56 完成；`build/web-desktop`、`site` 与浏览器实际读取的 `assets/main/index.js` SHA-256 为 `3f5dfffcd30209d2b868211a78c5000ba357f0bb7229f6c1e6ef8f6fb43fddfd`。

用户另行明确授权“部署上线”后，v3已于2026-10-17 17:48:34配套发布，并通过公网双人浏览器烟测；详见[生产发布记录](production-2026-10-17-session-v3.md)。本文仍区分本地故障验证与生产烟测。浏览器验收按用户授权执行，视口、键盘占用和安全区均为模拟，未声称真实手机、系统键盘或设备安全区验证。

最终全套 Vitest（`/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-all-vitest.json`）：436/436 通过；`pnpm typecheck:game` 与 `pnpm typecheck:server` 均退出 0（发布负责人最终重跑确认）。下列测试文件均包含在该全套结果中；不是把各次局部结果相加。

## 交付与路线图 M3 门槛

单进程写入整场聚合 JSON；独占临时文件、文件 fsync、rename、目录 fsync提交整场版本。完整手筹码、账本、回执、庄位及检查点一起提交。恢复在接入前加载校验；未结手回退最近完整手，保留已提交的入场、补码、离座、结束意图及绝对期限，并显示回退说明。

| M3 门槛 | 结果和证据 |
| --- | --- |
| 各下注轮请求结束，结清一次且无下一手 | 通过；D01/D02，B2/B6 |
| 房主主动离开在线移交，无在线候选等待恢复 | 通过；D04/D05 |
| 最后主动离开与全员断线区分 | 通过；D03/D06/D07 |
| 180 秒绝对截止跨重启保留 | 通过；D06–D09，真实强杀用例 |
| 检查点/补码/离开/重入/结束故障原子性 | 通过；D10/D11，真实 SIGKILL 27/27 |
| 第二手各轮重启回退、可见提示、私牌清除 | 通过；D12/D14，B2/B6 |
| 历史离开者、零和、重复恢复/结束不重算 | 通过；A、C、B2/B6 最终快照 |

## 规格全部场景：14/14

| 场景 | 规格原名 | 验证与结果 |
| --- | --- | --- |
| D01 | 各下注轮请求结束 | 通过；`SessionLifecycle.spec.ts` 参数化 preflop/flop/turn/river，拒绝非房主及旧连接；B2/B6 等本手完整结算 |
| D02 | 大厅结束与权限拒绝 | 通过；`SessionLifecycle`/`SessionPanels` 权限；S/M 大厅房主结束与访客禁用；M 取消不发送 |
| D03 | 最后一人手中离开 | 通过；`SessionLifecycle` 继续清理权益并保留历史；M 失败尝试专用房 QRRJ 显式离开后 persisted ended |
| D04 | 在线与待接任路径 | 通过；`SessionLifecycle`/`RoomLifecycle` 在线优先、保座候选等待及过期后才允许新访客接任 |
| D05 | 房主短暂断线 | 通过；`RoomLifecycle`、`OnlineSession` 同身份恢复与旧连接失效；B2/B6 同证明刷新和断网恢复 |
| D06 | 全断线等待内恢复 | 通过；`SessionLifecycle` 179999ms 恢复取消旧截止，后续全断线才建立新期限 |
| D07 | 准确边界到期 | 通过；`SessionLifecycle` 180000ms 到期、早到/迟到回调保护；C absolute-offline-deadline |
| D08 | 等待跨重启 | 通过；C 真实重复强杀保留原绝对截止时间；`SessionLifecycle` 相同边界 |
| D09 | 超时期间尚有未提交手 | 通过；`SessionLifecycle` 到期回退未结手，已完整提交则保留新检查点；C 绝对期限恢复结束 |
| D10 | 检查点提交前后进程强杀 | 通过；C checkpoint 的 before-write、after-file-sync、after-rename、after-directory-sync 四点；逐项比较整条旧/新记录 |
| D11 | 补码离开和结束提交进程强杀 | 通过；C rebuy、leaveRoom、rejoin、requestEnd 各四点，共 16 次；原请求仅一次效果 |
| D12 | 第二手不同轮次强杀 | 通过；C unfinished-second-hand 四下注轮；B2/B6 已完整第一手后真实 SIGKILL 第二手并清旧牌、保留补码 |
| D13 | 持久记录损坏 | 通过；`MatchRecord.spec.ts`、`MatchStore.spec.ts` 非法记录/损坏 JSON 启动拒绝，不忽略并新发筹码 |
| D14 | 相同手号不同恢复代号 | 通过；`OnlineSession.spec.ts`、`SessionGeneration.spec.ts`、`SessionLifecycle` tableEpoch/旧动画/旧动作屏障；C stale-action 拒绝 |

## 真实进程中断矩阵：27/27

| 类别 | 次数 | 强杀位置与核对 |
| --- | --- | --- |
| 完整手 checkpoint | 4 | 写前、文件同步后、rename 后、目录同步后；旧完整版本或新完整版本 |
| 补码生效 rebuy | 4 | 同上四点；余额、累计投入、次数与回执一致 |
| 离场清算 leaveRoom | 4 | 同上四点；归属只计一次 |
| 原身份重入 rejoin | 4 | 同上四点；离场扣回不新增首次投入 |
| 结束 requestEnd | 4 | 同上四点；固定结算和时间不重复 |
| 第二手四个下注轮 | 4 | 已有完整检查点后强杀；只回退未结手 |
| 已确认离座后回退 | 1 | 保留控制意图与独占归属；查询不重新占座 |
| 已确认结束意图后回退 | 1 | 回退后形成一次固定结算 |
| 全断线绝对期限重复重启 | 1 | 原180秒截止不延期，准确边界结束 |

证据为独立 Node 服务 PID、真实 `SIGKILL` 退出信号、同目录重新启动和 before/candidate/durable/restored 整条记录比较；27条退出信号全部为SIGKILL。并非仅用抛异常或内存 mock 宣称崩溃恢复。单元文件存储故障注入另用于稳定覆盖错误分支。

支持边界：单写进程、单机文件持久化，未声称多写进程、分布式事务或断电硬件存储保证。损坏已提交记录会拒绝启动。协议v3/schema v1不能以切回v2内存服务作为无损回退；备份与发布操作见独立运维说明。

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
