# Texas Hold'em

六人德州扑克现金桌 MVP，基于 Cocos Creator 3.8.8 制作。玩家与 5 名 AI 使用虚拟筹码进行完整一手牌：盲注、发牌、翻牌/转牌/河牌、下注、全压、边池和摊牌结算。

## 运行

1. 用 Cocos Creator 3.8.8 打开本目录。
2. 在 `assets/scenes/Game.scene` 打开 `Game` 场景，并将它设为构建的首场景。
3. 点击预览或运行。推荐使用 1280 × 720 横屏分辨率。

启动后先进入首页，可查看游戏规则或调整音效、动画速度和返回确认；点击“开始游戏”才会创建牌局。设置保存在本机并在下次启动时恢复。

进入牌局后，轮到你时可点击底部的弃牌、过牌/跟注、自定义加注或全压按钮。AI 会带有短暂停顿，并播放发牌、公共牌翻开和筹码移动动画。右上角“返回首页”可结束当前牌局；启用返回确认时会先显示确认弹层。

游戏提供按钮、卡牌、筹码和结算基础音效，不包含背景音乐。

选择“自定义加注”可直接输入总下注额、用 `−20 / +20` 调整，或选择最小、半池、满池、全压档位；确认前不会改变牌局。

## 规则测试

```bash
pnpm install
pnpm run typecheck:game
pnpm test
```

自动测试覆盖牌堆、七选五牌型评估（含 A-5 顺子与同牌桌平分）、盲注和轮转、弃牌结算、短码全压、边池构造及 AI 合法动作。

## GitHub Pages

`site/` 保存经过验证的 Cocos Web Desktop 静态包。推送 `main` 后，`.github/workflows/pages.yml` 会将该目录部署到 GitHub Pages：

```text
https://andrewkz.github.io/texas-holdem/
```

重新生成站点时，使用 Cocos Creator 3.8.8 构建 Web Desktop 正式包，并保持游戏画布为 1280 × 720。

## 结构

- `assets/scripts/core`：牌堆、牌型比较、边池及下注状态机。
- `assets/scripts/ai`：五名 AI 的合法行动策略。
- `assets/scripts/bootstrap/GameBootstrap.ts`：桌面横屏 UI、交互和动画。
- `assets/scenes/Game.scene`：挂载 `GameBootstrap` 的运行场景。
