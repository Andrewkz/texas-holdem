# 第一阶段生产发布记录

- 用户授权：2026-10-17明确要求“部署上线”。
- 上线时间：2026-10-17 14:46:54（Asia/Shanghai）。
- 游戏地址：[http://139.199.187.87/](http://139.199.187.87/)，WebSocket同源 `/ws`。
- 当前版本：`/opt/texas-holdem/releases/20261017-phase1-785c38c9`。
- 回退版本：`/opt/texas-holdem/releases/20261016-ui`，源码、静态包及已安装生产依赖均保留；没有执行回退演练。
- 当前入口：`/opt/texas-holdem/current` 指向本次release。前后端协议v2配套上线。

## 发布与校验

白名单包包含完整site、server源码及package/lock/tsconfig、共享扑克core源码与protocol、保留ESM边界的根package.json；52个文件SHA全部校验通过。不含macOS node_modules、凭证、测试目录或工程缓存。

发布压缩包SHA256：`3c1d12eaa79d3845db44c07364bbba75702944ba885488f2dd435fde0d895730`。

实际公网 `assets/main/index.js`、服务器release文件及本地验收文件SHA256一致：

```text
785c38c974fdaaa667344b2023f69c211586c019cd96e3bf84f666fe4bc0ef1d
```

在新release执行 `pnpm --dir server install --prod --frozen-lockfile`，Node22.18.0/pnpm10.15.0，生产依赖来自锁文件。临时127.0.0.1:2568运行实际服务，通过hello v2、建房、离房检查后关闭。未变更其他应用、Nginx配置或systemd配置；`nginx -t`通过。

两次切换前连接检查均无游戏WebSocket连接。先停止旧游戏进程，原子切换current，再启动新版，避免旧服务端与新版客户端混合运行。服务状态active/running，开机启动enabled，NRestarts=0，仅监听127.0.0.1:2567；临时2568监听已清理。旧进程在正常停止时记录退出143，随后新版启动正常，无自动重启循环。

## 公网浏览器烟测

Chrome真实公网流程6项全部通过，页面错误与失败资源均为空：

1. 公网首页与实际主包加载正常，所有页面主包SHA匹配验收版。
2. 唯一QA昵称创建专用房间，生成不含token的同源邀请。
3. 两个独立浏览器context通过真实UI加入、开局，各两张本人底牌。
4. 真实UI跟注/过牌被服务端确认；双向hello v2、实际参与者名单、按接收者隔离动作正确。
5. 刷新恢复同id/token，两张本人牌，无额外加入和首次5000筹码，总筹码10000。
6. 页面错误与失败资源均为零，实际脚本响应均匹配release。

测试仅操作新建QA房间2S8P；最后主动离房，使用原QA恢复令牌探测返回room-not-found，确认房间已销毁，没有普通加入其他房间。记录只保留token摘要，不保存令牌。

证据：[生产发布与浏览器记录](/Users/andrew/.codex/visualizations/2026/10/15/01a13e6e-d48b-71e0-8a8a-3b0feba4e0ca/phase1-production-release)，包含服务器状态、包manifest、烟测脚本、日志、结果与截图。

## 运行边界与回退

服务仍为单进程内存房间；重启不保留牌局，本次切换前未检测到游戏连接。第一阶段不包含账本、补码、正式整场结束、检查点/重启恢复和30天分享。浏览器验收范围遵循用户已确认的口径，未宣称真实手机系统行为已测。

若需回退，重新把current指向上述旧release并重启texas-holdem，前后端必须作为完整配套版本回退；需要重新验证HTTP与WebSocket并刷新旧标签页。本次仅保留回退条件，没有触发回退。没有Git提交、推送或OpenSpec归档。
