# 好友约局第一阶段验收记录

- 变更：`friends-poker-phase-1`，`spec-driven`；记录日期：2026-10-17。
- 结论：按用户2026-10-17明确要求“直接在浏览器做校验即可”，实际编译包的浏览器流程与手机视口模拟验收通过。第一阶段38/38任务完成；随后已获授权发布上线，见[生产发布记录](production-2026-10-17-phase1.md)，尚未归档。真实手机作为可选后续补充，不阻塞本阶段，也未被宣称已经验证。
- 范围：邀请、同座位恢复、个体化权限、真人中途入场、手机布局与输入。未包含账本、补码、正式结束本场、全员断线持久结算、重启恢复、30天分享。
- 本地验收阶段未操作生产；随后用户明确授权部署，已配套上线并完成公网烟测。未提交或推送代码。

## 构建与证据

Cocos Creator 3.8.8 Web Desktop 正式构建日志在14:31:35明确记录 `build Task (web-desktop) Finished`。日志也出现构建脚本worker退出SIGTERM诊断；因此不把CLI退出状态作为无警告成功的证据。CLI返回36，不能据此称为退出码0的无警告构建；以 Finished、产物校验和、下列实际产物浏览器验证共同确认可用。

`build/web-desktop/` 已同步到 `site/`。两处 `assets/main/index.js` SHA-256 均为：

```text
785c38c974fdaaa667344b2023f69c211586c019cd96e3bf84f666fe4bc0ef1d
```

浏览器实际载入编译后的引擎包，不用源码mock替代；独立本地服务 `http://localhost:8766/` + `ws://localhost:2567`。同源 `/ws` 和非安全 HTTP 回退用本机局域网预览 `http://192.168.50.119:8767/` 验证，该临时地址仅在本机服务运行且同网段时可用。

证据目录：[phase1-evidence](/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/phase1-evidence)。文件包括全量测试JSON、成功运行的浏览器脚本/日志、构建日志和截图；独立六浏览器身份及清理记录位于 `six-browser/results.json`。截图均为桌面Chrome模拟视口，不是真机。

验证命令：

```sh
pnpm exec vitest run --reporter=json --outputFile=/tmp/phase1-evidence/vitest.json
pnpm run typecheck:game
pnpm run typecheck:server
pnpm exec openspec validate friends-poker-phase-1 --strict
git diff --check
```

全量结果：**237/237**，0失败；游戏与服务端类型检查通过。真实WebSocket边界测试5条包含双人完整手牌、底牌隔离、连续身份补发和版本拒绝；180秒和30秒边界采用受控时钟，不能据此宣称物理设备切后台180秒已通过。

## 浏览器记录索引

| 文件前缀 | 覆盖内容 |
|---|---|
| `phase1-browser-qa` | 双独立context建房入场、刷新同身份、第三人中途加入/下一手、重复点击、断网恢复、邀请回退、三尺寸触摸、无效邀请/失效身份、旋转 |
| `phase1-full-table` | 六个真实socket与一个UI访客：满房拒绝、腾位后重试、六个冻结牌位含离座者、等待者零私牌/动作 |
| `phase1-six-browser` | 六个独立浏览器context全部真实UI入场/完成一手；在线房主接任；加注弹窗打开时自然回大厅；清理后原码入场失败 |
| `phase1-recovery-ui` | 同context双标签接管、取消延迟恢复保留凭证、旧协议仅hello不发token |
| `phase1-lan-smoke` | 非安全HTTP IP、同源/ws、剪贴板不可用、模拟原生分享取消、邀请入场和房间清理 |
| `phase1-return-solo` | 大厅重连提示保持、离房busy释放、单机重新发牌 |
| `phase1-compiled-entry` | 编译包AB23/YZ89规范化、错误返回、超过20字符完整endpoint原生输入并连接 |
| `phase1-keyboard-ui` | 模拟缩小视口、原生输入字号、键盘收起工具条44px、保留昵称 |
| `browser-final-mobile/` | 最终包19项：保持输入焦点旋转、昵称取消/确认、模拟键盘收起、44/8px模拟安全区、两手机尺寸四个44px动作、加注输入/取消/确认、弹窗阻断、零错误/资源失败 |
| `browser-final-recovery/` | 最终包9项：同源代理、双会话、CDP冻结跨手、断网、刷新保持身份与总筹码、双标签接管、取消迟到回调、旧协议拒绝，逐页实际main响应SHA一致 |
| `phase1-mobile-raise` | 667×375四动作均≥44px，规则/设置、原生加注输入/取消、快照不变 |

主流程、六浏览器、恢复与分享脚本记录页面错误/资源失败；通过结果没有应用运行异常或失败资源。原生分享取消为模拟异常分支，真实系统分享面板未测，按用户最新浏览器验收范围不阻塞。测试用房间主动离开并验证清理，未影响线上房间。

## 四份规格逐场景映射

测试文件位于 `tests/net/` 或 `tests/ui/`，下列英文片段为 Vitest `it` 标题，可从全量JSON定位完整断言；脚本名对应上表。实现检查与组合证据明确标注。

### room-invitations

| 规格场景 | 证据与边界 |
|---|---|
| 从含调试参数的页面分享 | RoomInvite：生成路径前缀 URL 的参数化测试；仅 room，无旧 query/fragment/凭证 |
| 从 IP 站点生成邀请 | RoomInvite HTTP IP 参数化用例；lan-smoke：真实非安全 HTTP IP，创建/分享/同源 /ws 加入 |
| 小写有效码 | RoomInvite accepts the complete room alphabet；compiled-entry：ab23/yz89 编译包预填大写，只在确认后连接 |
| 错误或有歧义的房间参数 | RoomInvite distinguishes absence / repeated parameters；OnlineEntry invalid invitations；browser-qa：AB0O 错误入口 |
| 同房间码存在于另一服务器 | OnlineEntry keeps a saved token away from a different complete endpoint；OnlineCredentials ignores stored identity and arbitrary server overrides |
| 普通联机入口使用开发地址 | OnlineCredentials resolves the server url with url-param > stored > default precedence |
| 无可移植部署目标 | RoomInvite permits sharing only for the site deployment backend / refuses nonportable URLs |
| HTTP 页面无法使用剪贴板 | lan-smoke：非安全 HTTP 的 clipboard undefined，完整可选文本和手动提示；browser-qa 复制失败回退 |
| 用户取消原生分享 | lan-smoke：模拟 navigator.share AbortError，回退可选文本且原房间不变；操作系统原生面板未测，不计入本次浏览器验证 |
| 房间已满 | RoomLobby rejects joining an unknown room or a full room；full-table：第七个 UI 访客显示已满，无座位/旁观，腾位后明确重试 |
| 邀请房间不存在 | compiled-entry：AB23/YZ89 实际连接后显示不存在，可返回 home，不建房 |

### online-seat-recovery

| 规格场景 | 证据与边界 |
|---|---|
| 对局中刷新 | Server delivers joined, frozen hand identities and private/public recovery state without transition delays；browser-qa 刷新同 playerId/token，恰好两张私牌 |
| 邀请指向另一房间 | OnlineEntry offers joining an invitation without sending a different room identity |
| 房间码被复用 | RoomLobby rejects a formerly valid token after the same room code and nickname are reused：复用码/昵称/playerId，旧真实 token 被拒绝 |
| 截止之前恢复 | RoomLobby accepts just before 180 seconds and rejects the exact boundary even when cleanup is late：179999ms 成功 |
| 截止边界与延迟回调 | 同一 RoomLobby 假时钟测试：180000ms 准确边界，故意不执行清理 timer 仍拒绝 |
| 重复断线通知 | 同一 RoomLobby 截止测试重复 handleClose 不续期；keeps a reconnected seat online when the superseded connection closes |
| 半开连接稍后才被检测 | 实现检查 Room.markDisconnected：识别当前绑定连接断开才以 Date.now 建立期限。未声称检测时延固定；无独立物理半开连接/heartbeat 延迟测试 |
| 临近超时时刷新恢复 | RoomHand does not reset an existing action deadline on recovery at 29 seconds：29s 恢复，原30s 到期弃牌 |
| 离线时有免费过牌 | RoomLifecycle auto-checks instead of folding when checking is free：显式断开行动玩家；收费动作由 auto-folds / 29s 测试覆盖 |
| 原座位失效 | OnlineSession reports session loss when the server rejects the reconnect；browser-qa stale credentials 可见失败且 online=null，不自动新加入 |
| 恢复中取消 | HomeFlow restores through lobby and ignores success after cancellation；OnlineSession dispose prevents late joined；recovery-ui 取消延迟 joined，保留凭证 |
| 连接打开但不回复恢复结果 | NetClient bounds opening, hello and joined waits；OnlineSession retries missing joined responses finitely / stops at the total budget |
| 新标签页接管旧座位 | OnlineSession ends the session without reconnecting when the seat is taken over；recovery-ui 两标签同座位，旧页可见接管且终止重连 |
| 过期连接延迟关闭 | RoomLobby keeps a reconnected seat online when the superseded connection closes；NetClient ignores old close and late acknowledgement after cancellation |
| 旧动画晚于恢复完成 | OnlineSession invalidates blocked old renders and lets a fresh recovery snapshot bypass the old queue / invalidates a blocked old hand；受控 Promise 验证新权威状态不被旧任务覆盖 |
| 连接已打开但快照未应用 | OnlineSession keeps actions blocked until the fresh snapshot finishes rendering / does not mark a primed playing room connected before its authoritative table is rendered |
| 发牌中刷新并重复补发 | OnlineSession deduplicates repeated hand replay and keeps exactly two own cards / rebuilds exactly two own cards when the same hand is recovered into a cleared view；browser-qa 刷新 |
| 新客户端连接旧服务端 | NetClient rejects incompatible acknowledgement / sends only hello before matching acknowledgement / fails closed on a push missing required participation fields；recovery-ui 旧端拒绝前只发送 hello 无 token |
| 旧客户端连接新服务端 | Server rejects old clients and incompatible versions before allocating any seat：真实 socket 的 create/reconnect/start/action 均不越过协议边界 |

### live-room-participation

| 规格场景 | 证据与边界 |
|---|---|
| 翻牌圈加入 | RoomHand gives a late joiner public state immediately and no cards or actions on every push：明确推进 flop；browser-qa 中途入场等待提示 |
| 等待者尝试发出动作 | 同一 RoomHand 测试强发 all-in 被拒绝，快照不变；browser-qa 空动作/不能行动 |
| 下一手开始 | RoomHand 三人/六人离座替换测试：新玩家下一手进入 participantIds，才有两张牌；browser-qa 实际等待到下一手 |
| 别人行动后仍是等待状态 | RoomHand late joiner every push；Server 连续补发真实 socket 测试后续行动仍 participation=waiting-next-hand，legalActions=[] |
| 参与者尚未轮到行动 | RoomHand replays the frozen participant list and recipient permissions after another participant folds；OnlineSession actions blocked until render |
| 零筹码座位未发牌 | RoomLifecycle recovers the dealer from blinds when a two-stack hand settles instantly with extra seated players：零筹码 Alice 不在名单、无 yourHand |
| 盲注全压 | 同一 RoomLifecycle 测试 Bob/Carol 盲注全压仍保留 participantIds；RoomHand runs out and settles a hand where both blinds are all-in |
| 本手中途弃牌 | RoomHand replays the frozen participant list and recipient permissions after another participant folds：Alice 弃牌、Carol 恢复，名单保留 Alice 且权限个体化 |
| 离座后新客户端中途加入 | RoomHand keeps a three-player departed identity separate from its waiting replacement until the next hand；Bob→Dave 替换保持旧名/冻结名单，等待者无私牌动作 |
| 满桌本手换人 | RoomHand keeps departed players in the current public snapshot when a full table seat is reused；OnlineSession uses actual dealt participants including departed identities；full-table：六个牌位含离座者，新等待者单独提示，无错牌/空引用 |
| 同步连续补发 | Server delivers joined, frozen hand identities and private/public recovery state without transition delays：真实 socket 精确 joined→roomState→handStart→yourHand→stateSync，等待者无 yourHand |
| 普通加入与恢复均受约束 | RoomLobby sends joined before roster on admission and reconnect；Server 连续补发真实 socket；实际构建 create/join/reload 均通过 |
| 仅剩一名有筹码玩家 | RoomHand refuses to start when fewer than two seated players have chips / runs out and settles a hand where both blinds are all-in；six-browser 真实离房后等30s行动+5s换手门槛回大厅 |
| 加注弹窗打开时回大厅 | six-browser：加注弹窗打开，其他玩家真实 UI 离房，服务端自然超时后回大厅，raise panel/overlay/旧动作清除；HomeFlow stale confirmation 回归 |
| 有在线接任者 | RoomLobby hands host to an online seat, or first valid recovery when all candidates are offline；six-browser 房主 UI 主动离房后 p2 在线接任 |
| 没有在线接任者 | RoomLobby preserves a pending host until the first retained seat recovers：新访客不能抢占待接任身份 |
| 仅房主短暂断线 | RoomLobby retains host ownership during a temporary disconnect and restores the same host seat：不断线移交，其他玩家 start 被拒绝 |
| 服务重启导致内存房间失效 | 组合证据：RoomLobby unknown room + OnlineSession rejected reconnect + HomeFlow failed restore；browser-qa 失效身份入口。未在生产/预览服务执行重启实验，保持内存限制说明 |

### mobile-poker-interaction

| 规格场景 | 证据与边界 |
|---|---|
| 小尺寸手机横屏 | PokerViewport 最终CSS触摸尺寸参数化测试；browser-qa：844×390=44.4px、667×375=44.5px；mobile-raise 验证四个动作均≥44px。browser-final-mobile 实测四动作、44/8px内边距模拟安全区均通过；真实设备安全区未测 |
| 六人牌桌 | full-table 六冻结牌位截图；six-browser 六独立页面两张本人牌；模拟横屏可视检查；最终手机视口及模拟安全区由 browser-final-mobile 通过 |
| 手机输入昵称 | keyboard-ui 模拟844×180缩小视口：输入实际字号≥16px，44px键盘收起按钮可达，昵称保留；browser-final-mobile 补充保持焦点旋转后的16.09CSSpx字号、缩小可视区域收起和内容保持；系统键盘未测 |
| 小屏加注 | mobile-raise：667×375真实原生 EditBox 输入200，未确认/取消不改变快照与底池；browser-final-mobile 补充加注键盘占用模拟、收起恢复、44/8px安全区确认取消可达、确认200精确改变筹码/底池；系统键盘未测 |
| 完整公网地址 | compiled-entry：完整 >20 字符 ws endpoint 用原生 EditBox 填入且实际建房；maxLength=2048，不截断 |
| 等待下一手 | browser-qa / full-table：等待横幅、公共牌桌、空动作，无本人私牌槽 |
| 快速重复点击 | HomeFlow guards the start transition against repeated input；browser-qa 连点 call/check 仅发送1条 action；OnlineSession 最新快照完成前始终禁用 |
| 竖屏打开邀请 | browser-qa 旋转保留昵称；PokerViewport 非有限/竖屏输入边界；CSS 竖屏引导。browser-final-mobile 实测保持输入焦点旋转，目标及昵称不丢且布局/字号同步 |
| 电脑与单机回归 | PokerViewport 1280×720/1440×900；browser-qa 两桌面尺寸；return-solo 联机离开后单机正常发牌；mobile-raise 规则/设置/加注/返回；全部规则引擎/AI/边池测试保留 |
| 浏览器流程验收 | browser-final-mobile：19项；browser-final-recovery：9项，记录Chrome版本、UA、访问URL、最终编译包SHA、模拟方式、页面错误和失败资源；已通过 |
| 模拟验证范围透明 | 用户已批准浏览器替代本阶段真机门槛；所有浏览器流程通过，可完成第一阶段。系统键盘、真实设备安全区、操作系统后台及原生分享面板未测，不能宣称真机通过 |

## 最终浏览器补验与缺陷修复

最终浏览器为Chrome155.0.8059.80，完整UA与时间戳见两份最终报告。WebKit本机未安装，未下载；本次不声称Safari或Android真机通过。

浏览器补验发现并修复两处实际缺陷：

- 保持原生输入焦点从390×844旋转到844×390时，旧实现把所有编辑中resize都跳过；现在区分键盘高度变化与宽度变化，旋转/安全区宽度变化会重新布局，保留焦点、目标和内容，并同步当前原生输入字体。复现脚本先失败、修复后通过，字号16.09375CSSpx、画布824×370。
- 加注遮罩原在顶部邀请/返回按钮下面，点击可能打开返回确认；现在调整兄弟节点层级，加注遮罩拦截顶部按钮，返回确认层自身仍保持最高。最小复现与完整手机视口用例均通过。

最终移动流程19项通过；667×375四动作44.48125CSSpx，844×390四动作44.41875CSSpx。模拟安全区采用body左右44px、上下8px内边距；键盘占用采用844×180缩小可视区域。昵称与加注均使用实际编译包的原生EditBox操作，未确认/取消不改变底池，确认总额200会产生精确筹码/底池差值。窗口/方向/焦点/visualViewport监听在onDestroy成对移除，实际源码已核对。

最终恢复流程9项通过。CDP Page.setWebLifecycleState frozen/active模拟浏览器页面冻结，跨手恢复后同身份且恰好两张底牌；offline/online加显式传输关闭验证真实服务端断线恢复；刷新只发reconnect，不新增身份，两个座位总筹码10000。所有页面实际加载的main响应SHA一致，页面错误及失败资源均为空；测试房间已主动离开，原码真实加入返回room-not-found。

六独立浏览器会话在最终构建上重新完成一手，房主在线接任与加注弹窗打开时自然回大厅再次通过。历史失败尝试和旧构建证据单独保留，不作为最终成功记录。

## 验证边界

未执行真实系统键盘、操作系统分享面板、设备env安全区或操作系统切后台测试；这些属于用户本次明确放到浏览器验收范围之外的后续可选补充。CDP冻结不是手机操作系统暂停，可视区域缩小不是系统键盘，页面padding不是设备安全区传感数据。

第一阶段仅在当前内存架构范围内通过验收；180秒保座/30秒行动期限仍由可追溯的服务端假时钟与真实socket契约测试证明，不把浏览器CDP模拟当成物理180秒离线实测。整场账本、补码、正式结束本场、持久化/重启恢复与30天结算分享仍属后续阶段。

用户随后明确授权“部署上线”，已配套发布协议v2前后端并通过公网烟测，详见[生产发布记录](production-2026-10-17-phase1.md)。OpenSpec尚未归档。
