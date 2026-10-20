# 好友扑克第四阶段验收：30 天只读分享与完整流程

日期：2026-10-17。对象：OpenSpec `friends-poker-session-lifecycle`，协议 v3，持久记录 schema v1。实际 Cocos Creator 3.8.8 构建于 17:30:56 完成；`build/web-desktop`、`site` 与浏览器实际读取的 `assets/main/index.js` SHA-256 为 `3f5dfffcd30209d2b868211a78c5000ba357f0bb7229f6c1e6ef8f6fb43fddfd`。

用户另行明确授权“部署上线”后，v3已于2026-10-17 17:48:34配套发布，并通过公网双人浏览器烟测；详见[生产发布记录](production-2026-10-17-session-v3.md)。本文仍区分本地故障验证与生产烟测。浏览器验收按用户授权执行，视口、键盘占用和安全区均为模拟，未声称真实手机、系统键盘或设备安全区验证。

最终全套 Vitest（`/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/session-lifecycle-evidence/session-lifecycle-all-vitest.json`）：436/436 通过；`pnpm typecheck:game` 与 `pnpm typecheck:server` 均退出 0（发布负责人最终重跑确认）。下列测试文件均包含在该全套结果中；不是把各次局部结果相加。

## 交付与路线图 M4 门槛

最终结算包含所有历史参与者的昵称、补码次数、累计虚拟投入、最终归属和净盈亏。独立 `settlement.html/js/css` 通过公开 API读取固定投影，不依赖游戏引擎或游客身份；shareId 与恢复证明分离。期限固定为 endedAt+30天，接口 no-store，准确到期返回410且无结算行。

| M4 门槛 | 结果和证据 |
| --- | --- |
| 在场/已离开者完整最终页、净值为零 | 通过；S01/S02，B2/B6 为3/7位历史参与者；WholeSessionLedger 两次补码 |
| 独立无账号浏览器只读 | 通过；S03/S04，S 专项独立 context，无WS、Cocos或身份读取 |
| 页面/API/URL无凭证及私牌 | 通过；S05/S06，精确字段白名单和秘密反向扫描 |
| 30天准确边界，访问/复制/重启不延期 | 通过；S07/S08，真实HTTP200/410及真实服务重启 |
| 两人和六人完整路径 | 通过；S09，B2/B6；最终增强轨迹完整保存 |
| 单机/合法行动/超时/摊牌/边池回归 | 通过；S10，436全套与38项实际编译包移动检查 |

## 规格全部场景：10/10

| 场景 | 规格原名 | 验证与结果 |
| --- | --- | --- |
| S01 | 离开者与多次补码者一起结算 | 通过；`WholeSessionLedger` 两次补码独立手算；B2/B6 最终 3/7 行含离开者；最终快照重复结束不变 |
| S02 | 未结清不得分享最终结果 | 通过；`SessionPanels`/`HomeFlow` 最终状态权威；`SessionLifecycle` ending-after-hand 等结清；B2/B6 当前手不中断 |
| S03 | 独立浏览器打开 | 通过；S 独立无身份 context，公开页不读取身份、不建立 WS、不加载 Cocos，HTTP 200 |
| S04 | 分享标识被当作游戏证明 | 通过；`Server.spec.ts` 真实 WS 将 shareId 当 reconnect token 得 invalid-proof；`OnlineCommands`/协议权限校验 |
| S05 | 敏感数据反向扫描 | 通过；S 扫描 HTTP/DOM/URL/请求精确公开白名单，排除已知恢复秘密、私牌及原始字段；`SettlementHttp.spec.ts` |
| S06 | 特殊字符昵称 | 通过；S 与 B2/B6 的 `<b>G</b>` 按文本呈现；`SettlementPage.spec.ts` 页面不生成该标签 |
| S07 | 准确失效边界 | 通过；S 真实 HTTP expiresAt−1 为 200、准确 expiresAt 为 410且无 rows；`SettlementHttp`/`SettlementPage` 补充之后边界与 no-store |
| S08 | 重复读取与重启 | 通过；S 重复 GET/复制后记录不变，真实 SIGKILL/重启固定 endedAt/expiresAt/shareId/rows；C 结束原子提交 |
| S09 | 两人和六人端到端 | 通过；B2/B6 实际编译包完整邀请→多手→中途加入→补码→离开重入→刷新断网→真实重启→结束→独立分享/到期 |
| S10 | 单机与手机视口回归 | 通过；M 四视口、原生输入、旋转、模拟安全区/键盘、Cocos/DOM 弹层；A 保留 AI、合法行动、超时、摊牌和边池 |

## 独立分享专项

S 专项6项全部通过，包含正常200、未知404、精确到期410、非法/冲突参数、链接清理、HTML样式昵称文本化和失败后无旧行。局域网HTTP不提供安全上下文剪贴板时，按钮真实选择完整URL并提示手动复制；没有假装复制成功。重复点击和读取后持久记录不变，真实SIGKILL重启后完整 ended 快照相同。此复制回退不代表已验证系统原生分享面板。

专项归档`session-lifecycle-evidence/public-share/`包含`public-200.png`、`public-expires-minus-1.png`、`public-expired-410.png`、`public-after-restart.png`、`public-unknown-404.png`等截图及隐私轨迹，完整路径见下表。故意访问404/410各有一条预期Chrome控制台错误；意外控制台错误、页面错误和失败请求均为0。

## 实际编译包移动回归

M 的38项全部通过，27张截图，Chrome155.0.8059.80。667×375四动作高44.48125px、844×390为44.41875px、1280×720为44.79896px、1440×900为44px；DOM账本/结束确认/取消均46px且可达。原生EditBox同一焦点从390×844旋至844×390，目标房间和昵称保留，有效字号16.09375CSSpx；昵称与加注在844×180模拟键盘占用时都有44px收起工具条，收起后值与布局恢复。

body左右44px、上下8px仅模拟安全区，表单/大厅/牌桌操作可达。单机实际输入200取消不改资金，确认产生精确差值；联机Cocos加注弹层阻断返回和账本入口，DOM账本阻断底层Canvas。M自己的两个测试房均已结束；失败尝试源于过早选择首手行动者和桌面错误期待移动工具条，均单独保留，修正临时脚本后通过，没有掩盖应用失败。

Browser插件不可用，按技能回退使用已安装Playwright和Chrome。实际URL为 `http://192.168.50.119:8767/`；六人及独立分享测试使用隔离端口8768/2568。未进行真实OS键盘、设备安全区、原生分享面板或实际移动Safari测试。

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
