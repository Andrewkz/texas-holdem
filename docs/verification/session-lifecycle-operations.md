# 整场持久化版本运行与发布边界

本说明对应协议v3。用户于2026-10-17明确授权“部署上线”后，配套版本于17:48:34部署到`/opt/texas-holdem/releases/20261017-session-v3-3f5dfffc`。发布与公网烟测见[生产发布记录](production-2026-10-17-session-v3.md)。后续版本按相应授权范围发布。

同日18:23:48针对用户反馈的可见下注计时缺失，当前release更新为`20261017-turn-timer-edc5ad1e`。协议v3增加可选的公开截止时间，schema仍为1；独立数据目录和权限不变。切换前服务停止后备份数据，切换后原有3条已结束记录SHA逐一保持一致。30秒行动窗口由服务端决定，倒计时不是新的客户端自动出牌逻辑。

## 本地运行

使用Node>=22和现有pnpm依赖，持久目录必须是实际目录、由单个服务进程独占。不要让两个不同端口服务同时写同一目录，也不要把目录指到静态site下面。

```sh
pnpm --dir server install --frozen-lockfile
POKER_DATA_DIR=/absolute/private/poker-data HOST=127.0.0.1 PORT=2567 pnpm --dir server start
```

默认目录由服务入口模块路径确定为server/data，不依赖运行命令的工作目录。该目录已加入.gitignore。自定义目录若包含符号链接祖先会被严格拒绝；macOS测试临时目录使用realpath后的真实路径。记录文件0600、目录0700；已提交JSON损坏时启动失败，不忽略旧场重新发筹码。临时.tmp残留不是恢复输入。

进程启动先验证并恢复全部记录，之后才监听。未完成手回到最近完整结算；已确认的身份、补码、离开与结束意图保留，并生成回退说明。持久操作先落盘再确认；保存失败会暂停本场，保留原请求ID和证明，不能通过重复点击绕过。

## 生产配置

仓库deploy/ubuntu/texas-holdem.service已准备：

- POKER_DATA_DIR=/var/lib/texas-holdem，独立于每个release。
- StateDirectory=texas-holdem、StateDirectoryMode=0700，由systemd按服务用户管理目录与权限。
- 保留User=ubuntu、ProtectSystem=strict和现有仅回环2567监听。

StateDirectory不会在服务停止时删除，并将该状态目录排除在ProtectSystem只读限制之外；见[systemd.exec官方说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。本次已安装到线上，实际目录为ubuntu:ubuntu、0700；临时预检使用独立临时目录。

Nginx保留静态site与/ws代理，新增/api/settlements/到同一2567 HTTP监听，不启用响应缓存。服务端公开接口也返回Cache-Control:no-store。分享静态页settlement.html/js/css不加载Cocos或游戏连接，只读公开最终投影；URL保留站点路径前缀，API沿用同源根路径/api/settlements/。

## 后续匹配发布与回退

新包应递归包含server/src（包括session子目录），server/package.json/锁文件/tsconfig、根package.json、共享assets/scripts/core与net/protocol.ts、net/SessionTypes.ts，以及完整site。不得包含server/data、测试数据、恢复令牌、Mac node_modules或工程缓存。生产依赖在独立release内通过锁文件安装。

发布前先检查正在使用的房间。旧v2只有内存状态，不能通过复制文件无缝迁移其进行中牌局；需要明确告知重启影响并在相应发布授权范围内安排。持久目录在第一版v3运行前创建；以后升级时先记录schemaVersion并保存一致备份。最保守的备份方法是停止该进程后复制所有已提交聚合文件，再按记录恢复服务；不要把临时.tmp作为备份恢复源。

回退必须配套客户端、服务端和可读的数据schema。旧v2完全不识别本场记录，不能切回旧v2并声称已有整场可无损继续；数据文件即使未删除，旧服务仍会表现成新内存场。需要保留升级前配套备份，拒绝不兼容schema，而不是静默丢弃记录。不要自动覆盖、清空或迁移生产目录。

公开分享严格固定为endedAt+30天。重启、复制和访问不延期；HTTP404或410不附带结算内容。已结束本场的参与者证明与公开分享标识是不同权限，分享标识不能恢复座位或操作牌局。

## 验收类型

- 确定性测试：账本归属、重复请求、边池、阶段状态及准确时间边界。
- 真实子进程：使用相同临时目录、命名提交屏障、SIGKILL并等待真实退出后重启，逐一验证检查点、补码、离场/重入、结束与期限。
- 实际编译包浏览器：两人和六人身份跑完整路径，核对页面实际脚本SHA；浏览器中的缩小视口、模拟安全区或受控时钟明确标注，不当作真实手机OS测试。

测试fixture的CRASH_*环境参数与IPC仅存在于tests/session/fixtures/child-server.ts，正常生产入口不接受客户端触发故障或修改时间。最终通过/失败证据以对应阶段验收报告为准。

2026-10-17 21:44:32后当前静态release为`20261017-private-club-e07fe89f`。UI/声音发布核对后端23文件与前版逐一相同，因此未重启服务、未修改POKER_DATA_DIR或schema；已有在线客户端可继续同v3联机，刷新后使用新版界面。
