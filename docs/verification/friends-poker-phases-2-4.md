# 好友扑克阶段2–4总验收

日期：2026-10-17。对象：OpenSpec `friends-poker-session-lifecycle`，协议 v3，持久记录 schema v1。实际 Cocos Creator 3.8.8 构建于 17:30:56 完成；`build/web-desktop`、`site` 与浏览器实际读取的 `assets/main/index.js` SHA-256 为 `3f5dfffcd30209d2b868211a78c5000ba357f0bb7229f6c1e6ef8f6fb43fddfd`。

用户另行明确授权“部署上线”后，v3已于2026-10-17 17:48:34配套发布，并通过公网双人浏览器烟测；详见[生产发布记录](production-2026-10-17-session-v3.md)。本文仍区分本地故障验证与生产烟测。浏览器验收按用户授权执行，视口、键盘占用和安全区均为模拟，未声称真实手机、系统键盘或设备安全区验证。

最终全套 Vitest（`/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-all-vitest.json`）：436/436 通过；`pnpm typecheck:game` 与 `pnpm typecheck:server` 均退出 0（发布负责人最终重跑确认）。下列测试文件均包含在该全套结果中；不是把各次局部结果相加。

## 结论与范围

阶段2账本15场景、阶段3生命周期14场景、阶段4分享10场景，共39场景已有自动测试、真实进程和实际编译包浏览器证据映射。分阶段逐条见 [阶段2](friends-poker-phase-2.md)、[阶段3](friends-poker-phase-3.md)、[阶段4](friends-poker-phase-4.md)。路线图M2/M3/M4门槛均在对应报告逐行列出。

| 验收层 | 实测结果 | 证据与边界 |
| --- | --- | --- |
| 全套回归 | 436/436，0失败 | A；含一期AI/规则/边池/身份恢复与新增WholeSessionLedger |
| 游戏与服务端类型检查 | 两项exit0 | 发布负责人最终重跑确认 |
| 三份规格 | 39/39场景覆盖 | L01–L15、D01–D14、S01–S10；不是39条浏览器测试 |
| 真实进程中断 | 27/27 | C；实际SIGKILL、重新启动与整记录旧/新比较 |
| 实际两人完整流程 | 成功 | B2；含新增晚到玩家，最终3位历史身份 |
| 实际六人完整流程 | 成功 | B6；满座第7人拒绝，离座替换后最终7位历史身份 |
| 移动/桌面呈现 | 38项通过，27张截图 | M；4视口，CSS模拟键盘及安全区 |
| 独立分享专项 | 6项通过 | S；真实HTTP边界/隐私/复制回退/真实重启 |
| 控制台与资源 | 无意外错误或失败请求；分享专项另有2条预期404/410控制台错误 | Browser插件不可用，使用已装Playwright+Chrome155；预期HTTP错误单列 |
| 生产发布 | 17:48:34切换v3；公网浏览器6项通过 | 独立记录见生产发布报告；仅操作专用QA场 |

## 构建与证据一致性

构建日志 `/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-build.log` 的最终Finished为17:30:56。早期试构建SHA `d48f3fc6…` 与一期线上 `785c38c9…` 不作为本次验收包；B2/B6/S/M均针对本文完整最终SHA。最终源码冻结后仅增加独立账本测试与验收文档；各浏览器页校验实际收到的主包哈希，不能用单纯本地文件存在代替实际加载。

## 完整浏览器流程

两个与六个隔离身份分别执行邀请与首次入场、多手操作、进行中加入等待、真实全压至爆零、取消/双击确认/下一手补码、离开重入、刷新及离线恢复、真实进程重启回退、房主本手后结束与独立分享到期。最终账本保留所有历史参与者和一次补码；B2最终净值为+5020/−5020/0；B6最终七行净值为−4980/−5000/+20000/−5000/−5000/−20/0，合计0。两条路径均清理临时私有数据与子进程。

浏览器服务fixture将手间等待设为30秒便于观察，动作超时仍30秒，全员断线180秒；产品默认手间5秒未因此修改。时间边界通过测试fixture时钟控制验证，不在生产暴露时间推进接口。持久故障矩阵是真实进程终止，不能与仅浏览器离线模拟混为一谈。

## 完成与发布边界

本地M2/M3/M4验收已有证据；负责人已独立执行OpenSpec严格校验（exit0），32/32实施任务全部核对完成，git diff --check通过。用户另行授权后已完成配套发布、公网实际包SHA校验、持久目录/权限和服务检查，以及公网浏览器烟测。生产变更另见发布记录；本变更未自动归档。

支持单机单写服务持久化；未宣称多写进程、真实手机OS行为、原生分享面板或Safari验证。所有筹码为虚拟统计，无充值、提现或真实资金功能。未来清理临时目录前应归档原始运行证据。

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
