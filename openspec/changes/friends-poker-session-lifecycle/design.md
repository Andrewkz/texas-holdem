# Design

## Context

动机见proposal。当前第一阶段38/38已验收并上线，但Room仍把参与者、座位和连接混为一体：addPlayer每次发5000，离座者被删除，最后离开直接删除房间，finishHand无条件安排下一手。EngineSnapshot不包含结算后庄位、账本或控制期限，不能直接当恢复记录。凭证只按roomCode保存，主动离房会清掉唯一证明。

用户已授权继续完成原路线图剩余阶段，并明确采用浏览器验收。本设计落实既定行为，不新增账号、付费或玩法。开发在当前工作树进行，保留已批准但尚未提交的完整第一阶段基线，不提交或推送；生产本次仍是已发布v2，后续发布另按对应授权执行。

## Goals / Non-Goals

**Goals:** 本场聚合与扑克引擎分离；稳定身份、账本、回执、检查点和生命周期有明确原子边界；在单进程内保持同步串行操作，真实崩溃可恢复；只读分享与身份连接隔离。按阶段2账本→阶段3持久生命周期→阶段4分享交付并各自留验收记录。

**Non-Goals:** 不恢复未完成手的牌堆/私牌；不引入数据库或外部运行依赖，不运行多写入进程，不扩充已确认产品范围。不自动归档、提交、推送或部署新版本。

## Decisions

### 1. 稳定身份与入场证明

每场生成UUID sessionId；playerId保持pN但在该场内永不复用，nextPlayerNumber持久化。房间码只是入口，可被后续场复用。Room保留所有Participant历史，seatStatus为seated/leaving-hand/left，socket与timer仅在内存。

新协议v3先hello，再lookupRoom取得该码当前sessionId，才匹配按完整endpoint+sessionId保存的身份。有邀请不会把旧同码证明发到新场。reconnect只恢复有效在座身份；rejoin是用户明确发起的原身份重入，已离座证明不会自动占座。已结束场返回sessionEnded，不能变成“丢失房间重新领5000”。

初次create/join包含requestId和浏览器用crypto.getRandomValues产生的高熵token（不依赖HTTP环境下不可用的randomUUID）。客户端先保存待确认入场；服务端只保存token哈希。同一请求+证明重试返回原身份，避免joined确认丢失后重复首次投入；同ID不同负载拒绝。令牌不入日志、邀请或分享，重连时只回显本人提交的证明。

普通离房清活动座位指针但保留本场游客证明和autoResume=false；页面提供“返回原场”明确重入。多场身份按endpoint+sessionId索引，旧v2单条凭证保留兼容读取并清楚提示无法恢复，不静默新入场。昵称不是证明。

### 2. 纯账本聚合与权益

server/src/session/SessionLedger.ts只负责不可分割的筹码归属，不依赖socket、文件或引擎。LedgerData包含sessionId、committedHandId、participants、entries与待补码。每行保存playerId、nickname、seatStatus、totalBuyIn、rebuyCount、stack（最近提交的在场余额）、releasedChips（离场净归属）、pendingDepartureHandId和pendingRebuyRequestId。所有筹码是非负安全整数。

初始只记一次5000。补码请求只在已结清stack=0且未离座时排队；下手发牌之前原子变更stack/totalBuyIn/rebuyCount并记录生效手号。当前手已发牌者的临时全压0不改变账本stack，不能当作补码资格。离座或结束取消未生效补码并记录明确结果。

手中离开只标leaving-hand：非全压按原自动弃牌，全压保留引擎主池/边池资格。完整手settle后同步所有实际参与者筹码，再将待离座余额转releasedChips、stack置0。未结清重入返回pending-equity，结清后明确重入才把releasedChips转回stack，投入不增加。事件记录离开/重入方向，最终F=releasedChips+stack、P=F−totalBuyIn；所有历史参与者合计P=0。当前手中只显示已结算边界或待结清，不能显示暂估“最终盈亏”。

不选择单独维护另一份客户端余额；引擎裁决仍是本手权威，账本只在完整手提交时接受结果。重复finishHand以handAttemptId去重，未结清底池不被管理流程改写。

### 3. 单份原子持久记录

MatchRecord包含schemaVersion、sessionId、revision、roomCode、createdAt、凭证哈希、LedgerData、有序座位、庄位、nextPlayerNumber、单调handAttemptId、checkpointVersion、inFlightHandId、结束/离座/补码意图、幂等CommandReceipt、各座位/全员断线绝对期限、回退通知和可选最终结算/分享。

MatchStore<T extends {sessionId:string;revision:number}>同步提供loadAll():T[]与commit(next:T,expectedRevision:number):void。MemoryMatchStore用于确定性测试；FileMatchStore每场一个聚合JSON文件，临时文件exclusive写入→fsync→同目录原子rename→目录fsync，确认在全部步骤之后。临时残留不当作提交记录，已提交JSON损坏则启动报错。文件权限0600、目录0700，拒绝路径穿越。revision冲突拒绝。明确仅单服务进程拥有数据目录；不承诺多写进程协调。

选择整个聚合原子文件而非分别写账本/检查点，避免跨文件半提交；不选SQLite以保持现有Node22部署无新增运行依赖，并使故障屏障可直接控制写入/rename/确认边界。同步小记录适合单桌2–6人的当前单进程规模；未来高吞吐可替换Store接口，不在本次扩展。

Room构造下一份clone，commit成功才替换持久状态、确认管理命令、发布最终结果或开下一手。Node事件循环与同步commit保证该场命令/行动/timer不发生await交叉；不额外引入异步队列。提交失败暂停该场、禁用行动并显示错误，不能广播成功后才落盘。

### 4. 检查点与不可回退的控制意图

持久账本stack总是最近完整手边界；手内Engine只在内存。开手前保存单调inFlightHandId和庄位/已提交边界，不保存底牌。中途加入、补码请求、离座和结束意图独立更新聚合，不能把临时engine筹码顺带提交为完整手。

完整手提交一次记录全部筹码、离场清算、待补码/回执、庄位和checkpointVersion，之后才发布结算/启动后续流程。恢复读取相同聚合：若inFlightHandId存在，则丢弃该手临时变化，用已提交stack重建大厅，按保留控制意图处理离座和结束，生成recoveryNotice。handAttemptId不回退，新运行tableEpoch更换；客户端清除旧私牌/赢家/弹窗并展示回退说明。不会从EngineSnapshot反推丢失的牌堆。

真实独立子进程故障屏障仅由显式测试注入函数开启，不提供客户端触发能力：提交前/临时文件fsync后/rename后/确认前强杀，重启原目录核对确切旧或新完整版本；已确认提交必须恢复新状态。

### 5. 生命周期及期限

room.phase继续表达lobby/playing，另以lifecycle表达active/ending-after-hand/all-offline-wait/ended。房主结束和最后明确离开：若有手则正常完成全部权益，设置ending-after-hand阻止下一手；大厅直接finalize。短暂断线保座180秒，行动30秒不重置；旧连接关闭不影响新连接。

最后在线座位断开时持久记录allOfflineDeadline=识别时刻+180000，禁止再开新手，行动超时仍按原规则。单人座位期限不能删除本场、缩短或延长全员期限。有效恢复取消等待；准确截止及之后恢复不能越过结束。重启沿用绝对期限；恢复时先处理过期，再接受连接。

全员期限到期时若仍未完整结算，按与重启相同的检查点回退后结束，reason=all-offline-timeout并保存recoveryNotice；不虚构赢家。已完整提交的最新手保留。此路径与最后主动离开的正常清算区分。

### 6. 协议与客户端边界

协议v3共享SessionTypes.ts定义LedgerSnapshot、SessionMeta、CommandResult、RecoveryNotice和FinalSettlement。RoomState附session元数据；handStart/stateSync携带tableEpoch，行动必须带sessionId+tableEpoch+handId，过期即拒绝。Client管理命令rebuy/requestEnd/leaveRoom/rejoin/commandStatus都有requestId和sessionId；服务器以sessionId+playerId+type+requestId存回执及负载摘要，重复相同返回原结果。

NetClient保留有界hello/连接确认，新增有界admission及command等待。管理请求超时显示结果待确认，沿用原requestId查询/幂等重试；出牌绝不重放。OnlineSession负责session/epoch失效、账本与结束回调，不在动画里记账。最终消息先失效旧牌桌再显示结算。离房等待有限确认且保留本场证明，最后离房的结算可通过保留证明读取。

GameBootstrap只接线，新增独立SessionPanels DOM呈现账本、补码/结束确认与最终结果，触摸目标至少44CSSpx、textContent渲染昵称。独立settlement.html/js/css在静态模板中构建，先读分享参数再请求HTTP；不载入游戏引擎、不访问游客凭证、不建立游戏WebSocket，避免只读分享触发自动恢复。

### 7. 固定分享及HTTP

结束同一提交内生成不可猜测shareId、endedAt、expiresAt=endedAt+30*86400000和固定FinalSettlement。GET /api/settlements/:shareId仅允许公开投影：sessionId、结束/过期时间、结束原因/回退说明、每行playerId/nickname/rebuyCount/totalBuyIn/finalChips/net。未知404，到期now>=expiresAt返回410且无结算内容；cache-control:no-store，访问/复制不写记录或续期。

HTTP与WebSocket共用监听端口，保留/ws代理，新增Nginx /api/settlements/代理；不为分享建立游戏权限。HTML特殊字符只作文本，HTTP响应/DOM/请求用已知凭证/私牌反向扫描。

## Risks / Trade-offs

- 管理意图与手内快照混写会丢已确认请求或保存临时输赢→用持久边界余额和独立inFlight标记，真实SIGKILL矩阵证明。
- 重入与离场归属双计、全压离座丢池→独立账本事件与确定牌面主/边池测试，最终独立核对零和。
- 存储故障后内存继续运行→只在提交后确认，异常暂停该场，不吞错或创建新身份。
- v3与已上线v2不兼容→本次仅本地开发，后续匹配发布；旧内存房间不能无中断迁移，发布前明确检查。
- 同步文件IO与记录增长→当前单进程低并发边界，记录隔离每场；不宣传多实例或无限规模。
- 浏览器模拟无法证明OS行为→沿用用户已批准浏览器验收，准确记录模拟与未测范围。

## Migration Plan

1. 保留完整第一阶段未提交基线，先测现有237项和两端类型检查；通过小模块并行实现账本/Store、v3网络、Room生命周期，文件所有权明确。
2. 接入客户端独立面板与静态分享；跑阶段2权益/幂等、阶段3真实故障、阶段4HTTP与隐私测试，逐项记录而非只计测试数。
3. Cocos3.8.8重建并同步site，验证实际SHA；独立本地服务完成两人/六人全链路，保留全部一期回归与浏览器模拟证据。
4. 为后续部署准备POKER_DATA_DIR独立目录及systemd StateDirectory/读写权限、Nginx API代理；不将持久记录放进release或发布包，不上传本地测试数据。
5. 后续获得该版本发布授权后，先检查在线房间及旧v2内存中断影响，备份数据再匹配发布前后端。只在数据schema可读时回退新旧代码；不得直接把含持久状态的新版本回退成会忽略数据的旧v2并称为无损。
