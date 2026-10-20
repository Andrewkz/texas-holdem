# Private Club Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 落实用户确认的7项UI、交互与音效改进并完成实际浏览器验收。

**Architecture:** 保留Cocos牌桌及权威协议；新增独立BettingPanel和SoundPanel负责DOM原生输入，SessionPanels只改呈现。纯音效gate与下注authority校验可独立测试；Bootstrap只接线和渲染。

**Tech Stack:** Cocos3.8.8、TypeScript、DOM、WebAudio/Cocos AudioSource、Vitest2、现有Playwright/Chrome。

**Spec:** docs/superpowers/specs/2026-10-17-private-club-polish.md

## Global Constraints

- 无新运行依赖；单机/2–6人联机规则、v3/schema1保持不变。
- 当前dirty checkout包含已发布基线，原地保留，不reset/stash/提交/推送。
- Pen原稿保留，按新增Private Club画板及spec tokens实现，所有新assets脚本带.meta。
- 主要触摸≥44CSSpx、文字输入16px；浏览器验收不冒称真机。

### Task 1: 音频与设置

Files: GameAudio.ts、GameSound.ts、GameSettings.ts、SoundPanel.ts/.meta、audio WAV/.meta及对应tests。
Interfaces: GameAudio(node,()=>settings).play/destroy/unlockFromGesture；TurnSoundGate.read({turnKey,isOwnTurn,seconds,canAlert})；SoundPanel({getSettings,onChange,onClose}).open/close/destroy/isOpen。
- [x] 旧设置兼容、volume/mute/alert、去重与无后台积压用例先失败。
- [x] 实现轻写实音源、门控、5项设置DOM与独立开关，单元与DOM回归通过。

### Task 2: 安全下注抽屉

Files: BettingPanel.ts/.meta、下注校验model及tests。
Interfaces: BettingContext {authorityKey,canAct,busy,bounds,canAllIn,allInAmount}；BettingPanel({getState,onConfirm,onClose,onInteract?}).openRaise/openAllIn/update/close/destroy/isOpen。
- [x] 写过期确认、金额、取消、二次全压、双击回归先失败。
- [x] 实现input/range/presets与44px底部抽屉，确认前getState再校验并先关闭防重。

### Task 3: 本场与分享呈现

Files: SessionPanels.ts/tests、style.css仅session段、settlement模板/tests。
- [x] 保留h3/data-action和隐私/权限/回执测试，补interact与呈现测试。
- [x] 统一palette/紧凑列表/盈亏层级/可访问标题/复制回退，不改parser与领域数据。

### Task 4: Cocos整合

Files: GameBootstrap.ts、PokerUiTheme.ts、TurnCountdown.ts及相关tests、style.css非session段。
- [x] 接入DOM下注/声音面板，关闭与失效恢复、键盘排除range。
- [x] 显示头像倒计时环、行动筹码/过牌/弃牌分别反馈、一次结算声及牌桌静音。
- [x] 首页联机优先与全流程配色、牌面/数值排版、手机/桌面布局对照Pen。

### Task 5: 验证与交付

- [x] 完整Vitest、双typecheck、git diff --check、独立审查。
- [x] Cocos实际构建、SHA和site同步；真实浏览器两人/六人以及单机、抽屉/全压/重连、移动输入与音效门控验证。
- [x] 检查Pen与浏览器截图至少5项对比并修复差异；归档证据；只报告已验证范围。

完成证据：482全套+双types通过；实际包2人/6人、音频11项与设置/键盘单机回归；Pen11画板保存；公网最终e07fe89f，静态发布不重启后端。原始记录在工作区外private-club-evidence。
