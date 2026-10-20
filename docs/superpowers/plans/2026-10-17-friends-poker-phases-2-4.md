# 好友约局第二至四阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成既定整场账本/爆零补码、可靠结束/检查点/重启回退、固定30天只读结算分享，并以真实进程和实际浏览器证明。

**Architecture:** 稳定本场聚合独立于座位/连接和手内扑克引擎。纯账本维护最近完整边界，单场整份记录以同步原子文件事务提交，v3协议区分管理命令与不重放的行动，独立静态分享页仅获取公开HTTP投影。

**Tech Stack:** Cocos Creator3.8.8、TypeScript、Node>=22、ws、pnpm、Vitest、Playwright；不添加运行依赖。

**Spec:** `openspec/changes/friends-poker-session-lifecycle/{proposal.md,design.md,specs/*/spec.md,tasks.md}`；上位产品范围为`docs/superpowers/specs/2026-10-16-friends-poker-roadmap.md`。

## Global Constraints

- 2–6名真人、仅虚拟筹码、初始5000、固定盲注20/40、免费补至5000且下一手生效；保留单机AI。
- 本场与参与者身份不随座位删除，昵称不能作证明；原身份重入不发首次筹码。
- 全压离座保留主池/边池权益，未结清不显示最终数值，全体最终ΣP=0。
- 房主请求结束/最后主动离开正常清算当前手；全部仅断线等待180000ms、不发新手，到期未结手统一检查点回退后结束。
- 同步单写入进程；整个本场的筹码/账本/回执/控制/最终结果原子提交，成功确认必须在目录fsync之后。
- 真实子进程SIGKILL测试是完成门槛；浏览器手机视口验收已获授权，不冒称真实OS验证。
- 所有新增assets文件配套.meta；Cocos避免Set/Map展开，采用Array.from。
- 工作树包含已批准但未提交的一期改动，继续原地修改并保存审查证据；不reset/stash、无自动提交/推送/归档或生产操作。
- OpenSpec tasks.md是唯一完成进度；以下执行步骤不代替其证据门槛。原计划用户已确认，本次连续实施无需在每个任务间重问。

## 文件所有权与共同接口

账本/存储实现者仅写`server/src/session/SessionLedger.ts`、`MatchStore.ts`、`MemoryMatchStore.ts`、`FileMatchStore.ts`及各自tests。服务端实现者写`Room.ts`、`RoomManager.ts`、`session/MatchRecord.ts`、`server.ts`、`index.ts`及Room/HTTP/Crash测试。网络实现者写`assets/scripts/net/SessionTypes.ts`、`protocol.ts`、`OnlineCredentials.ts`、`OnlineEntry.ts`、`NetClient.ts`、`OnlineSession.ts`、`OnlineCommands.ts`及网络测试。主控制者写GameBootstrap/HomeFlow、独立SessionPanels、分享模板、部署文档与验收证据；共同文件不同时交给不同实现者。

账本的数据和方法契约：

```ts
export type SeatStatus = 'seated' | 'leaving-hand' | 'left';
export interface LedgerParticipant {
  playerId:string; nickname:string; seatStatus:SeatStatus;
  totalBuyIn:number; rebuyCount:number; stack:number; releasedChips:number;
  pendingDepartureHandId:number|null; pendingRebuyRequestId:string|null;
}
export interface LedgerEntry {
  id:string; playerId:string; type:'initial'|'rebuy'|'depart'|'rejoin'|'hand-settlement';
  amount:number; handId:number; requestId:string|null;
}
export interface LedgerData {
  sessionId:string; committedHandId:number; participants:LedgerParticipant[];
  entries:LedgerEntry[]; appliedHands:{handId:number;stacks:Record<string,number>}[];
}
export class SessionLedger {
  constructor(data:LedgerData);
  static create(sessionId:string):SessionLedger;
  toJSON():LedgerData; // deep clone, no caller mutation
  addParticipant(playerId:string,nickname:string,requestId:string):LedgerParticipant;
  queueRebuy(playerId:string,requestId:string):boolean;
  applyPendingRebuys(nextHandId:number):string[]; // applied request IDs
  cancelPendingRebuys(playerId?:string):string[];
  requestDeparture(playerId:string,handId:number|null):void;
  settleHand(handId:number,stacks:Record<string,number>):boolean;
  rejoin(playerId:string):void;
  resolveRolledBackHand(handId:number):string[]; // cashout pending leavers at committed boundary, no committedHandId advance
  assertConserved():void;
}
```

余额字段为非负安全整数；hand-settlement事件amount为允许负数的安全整数余额差。重复add同参与者/昵称不再投入、不同昵称冲突。queue同pending request返回false，已有其他待补码拒绝；历史已生效相同request不能再生效。requestDeparture无手即cashout，有手标待结清；rejoin对待结清明确拒绝，left余额从releasedChips扣回stack。settleHand重复完全相同数据返回false，不同数据同手拒绝，允许回退后跳过未提交手号。pending取消返回ID供Room持久回执标明不生效。

Store契约：

```ts
export interface AggregateRecord { sessionId:string; revision:number }
export interface MatchStore<T extends AggregateRecord> {
  loadAll():T[];
  commit(next:T,expectedRevision:number):void;
}
export type CommitPoint='before-write'|'after-file-sync'|'after-rename'|'after-directory-sync';
// FileMatchStore<T>(directory:string, validate:(raw:unknown)=>T,
//                   hooks?:{at?:(point:CommitPoint,record:T)=>void})
// MemoryMatchStore<T>(initial?:T[])
// next.revision === expectedRevision + 1, first expectedRevision=0.
```

公共v3详细DTO由网络实现者先写SessionTypes.ts并通知其他实现者。固定契约：sessionId、稳定playerId、room.phase仍lobby|playing，session元数据描述lifecycle；ledgerSync独立于engine，sessionEnded为终态。lookupRoom返回当前sessionId且不分座；初次create/join携requestId+高熵token，join同时绑定lookup的sessionId。reconnect/rejoin绑定sessionId+token；管理命令requestId；action额外绑定sessionId+tableEpoch+handId。回执pending/committed/rejected，commandStatus查询原ID；公开分享DTO明确白名单。Cocos不导入server模块。

### Task A：基线和v3契约（对应1.1–1.2）

**Files:** SessionTypes/protocol/.meta、tests/net/protocol.spec.ts、网络fake夹具；ledger中记录baseline237及两端typecheck输出。

- [ ] 运行基线完整命令，记录真实结果：

```sh
pnpm exec vitest run --reporter=json --outputFile=/tmp/session-lifecycle-baseline.json
pnpm run typecheck:game
pnpm run typecheck:server
```

- [ ] 先写非法账本数、缺失tableEpoch、未知生命周期和管理命令校验失败用例，再实现解析；公开字段类型放共享模块，保留原引擎类型。

```ts
expect(parseClientMessage({type:'rebuy',sessionId:'s',requestId:'r',amount:999})).toBeNull();
expect(parseClientMessage({type:'action',action:{type:'fold'}})).toBeNull();
```

- [ ] 跑protocol与NetClient聚焦，交接实际导出的DTO和签名，冻结共享文件所有权。

### Task B：纯账本（对应2.1–2.3）

**Files:** server/src/session/SessionLedger.ts、tests/session/SessionLedger.spec.ts。

- [ ] 先复现重复初始投入、两种离开/重入、补码待生效和结算去重，再按共同接口实现。

```ts
const ledger=SessionLedger.create('s');
ledger.addParticipant('p1','A','join-a');ledger.addParticipant('p2','B','join-b');
ledger.settleHand(1,{p1:0,p2:10000});ledger.queueRebuy('p1','rebuy-1');
expect(ledger.toJSON().participants[0].stack).toBe(0);
ledger.applyPendingRebuys(2);
expect(ledger.toJSON().participants[0]).toMatchObject({stack:5000,totalBuyIn:10000,rebuyCount:1});
ledger.requestDeparture('p2',null);ledger.rejoin('p2');ledger.assertConserved();
```

- [ ] 确认失败后实现最小聚合，用相同手号不同payload、负余额、外部修改导出对象、同周期换ID补码扩展边界；审查不变量后交接。

### Task C：原子Store（对应3.1–3.2）

**Files:** Store三个模块、tests/session/MatchStore.spec.ts。

- [ ] 先让CAS与完整版本测试失败，再实现clone、校验、temp/fsync/rename/dirfsync及hook。

```ts
const first={sessionId:'s',revision:1,value:{stack:5000,buyIn:5000}};
store.commit(first,0);
expect(()=>store.commit({...first,revision:2},0)).toThrow();
expect(store.loadAll()).toEqual([first]);
```

- [ ] 每个hook异常分别核对确切提交边界；损坏文件必须报错、temp不能当记录、非法文件名/符号链接不能越界。随后用真实SIGKILL任务验证而不把mock算作崩溃门槛。

### Task D：Room与管理命令（对应3.3、4.1–4.5、6.1–6.4）

**Files:** MatchRecord、Room、RoomManager及相关tests。

- [ ] 定义严格MatchRecord与公开投影，token只存哈希；先写create/join确认丢失重试、rejoin归属和全压离座红例，再接Ledger/Store。

```ts
const before=manager.roomCount();
manager.handleMessage(conn,createCommand);manager.handleMessage(retry,createCommand);
expect(manager.roomCount()).toBe(before+1); // same requestId/token
```

- [ ] 在Room开手前原子保存inFlight与待补码生效，结算以handAttemptId一次提交；所有管理回执在提交之后，存储失败暂停而不发假成功。
- [ ] 各下注轮结束、最后主动离开、全断线179999/180000与重启绝对期限均写直接测试；全断线到期未结手走统一rollback，再固定结束。
- [ ] index恢复先于listen；tableEpoch更新、单调手号和回退通知让客户端能拒旧动作。Run Room/Server/Session聚焦及server typecheck，再交接。

### Task E：网络与客户端界面（对应5.1–5.5）

**Files:** Credentials/Entry/NetClient/Commands/OnlineSession、HomeFlow、SessionPanels、Bootstrap及.meta/tests。

- [ ] 先写entry的lookup稳定身份与active指针测试，以及丢确认原requestId查询/取消迟到回包测试，再实现有界admission/command等待。
- [ ] UI将账本、补码确认、结束确认和最终结果放独立SessionPanels；请求发起一次，未知结果不换ID重做，非当前行动人和恢复期间不启用动作。

```ts
// UI consumes server DTO, never computes buy-ins from card/chip animations.
const panels=new SessionPanels({onRebuy,onRequestEnd,onRejoin,onClose});
panels.renderLedger(snapshot);panels.renderEnded(settlement);
```

- [ ] 精确callbacks以SessionPanels实际导出为准由主控制者统一，网络实现者交接handlers时不得自己改Bootstrap。
- [ ] 编译包浏览器验证爆零补码、离开后明确重入、超过六历史行、44CSSpx与模态阻断；保留一期回归。

### Task F：真实崩溃与部署准备（对应6.5–6.6）

**Files:** CrashRecovery.spec.ts、tests/session/fixtures/child-server.ts、deploy/ubuntu配置、README。

- [ ] 父进程用临时目录启动子进程，以IPC故障屏障证明已到精确commit点，然后kill('SIGKILL')并等待terminal，再同目录重启。

```ts
await child.waitForBarrier('after-file-sync');child.kill('SIGKILL');await child.exited();
const restored=await startChild({dataDir:sameDirectory});
expect(await restored.record()).toEqual(expectedOldCompleteRecord);
```

- [ ] 覆盖手结算、补码、离场/重入、结束、全断线截止跨重启；每组保存PID/版本/回执与旧新精确断言。不要用延时猜测已达到提交点。
- [ ] 准备独立POKER_DATA_DIR和StateDirectory；不操作生产，记录v2内存迁移与持久schema回退限制。

### Task G：只读分享（对应7.1–7.4）

**Files:** HTTP共享server、settlement模板三个文件、Share测试和Nginx配置。

- [ ] 先测结束固定快照/30天边界/隐私，再实现GET公开白名单，不直接序列化MatchRecord。

```ts
clock.set(endedAt+30*86400000-1);expect((await getShare()).status).toBe(200);
clock.set(endedAt+30*86400000);expect((await getShare()).status).toBe(410);
expect(JSON.stringify(await getPublicBody())).not.toContain(knownRawToken);
```

- [ ] 独立settlement.html不加载Cocos、不读credentials、不连WS；DOM用textContent，no-store，路径前缀与copy回退通过真实浏览器。

### Task H：最终验收（对应8.1–8.4）

- [ ] 完整Vitest与两端typecheck通过后独立审查；每个实质修改跑相关红绿验证，避免用镜像实现的测试替代产品不变量。
- [ ] Cocos3.8.8正式包Finished+SHA+实际运行证据齐全后更新site；browser最终包逐页SHA匹配。
- [ ] 两人与六人各完成全链路，真实重启由本地独立进程完成，分享独立context及过期API一起验证；记录console/failedresources并清理自己测试场。
- [ ] 阶段2/3/4报告与全规格场景一一映射；OpenSpec严格校验、任务sourcePath/line逐项核对后勾选，只有全部门槛有证据才完成整个目标。
