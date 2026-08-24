# Cocos 德州扑克 UI 对齐实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Cocos Creator 的德州扑克运行时 UI 对齐 `poker.pen` 的主牌局、加注弹层与结算状态，同时保持现有规则和金额计算行为。

**Architecture:** 将不依赖 Cocos 的颜色、座位、按钮和牌桌布局提取到 `PokerUiTheme.ts`，使其可以由 Vitest 覆盖。`GameBootstrap.ts` 继续负责 Cocos 节点创建、渲染和 tween 动效；它只消费主题和布局数据，不修改 `PokerEngine`、AI 或加注归一化代码。

**Tech Stack:** Cocos Creator 3.8、TypeScript、Vitest。

**Version-control boundary:** 当前仓库是无初始提交的 `main`，不能创建 worktree 或执行提交；保留所有更改在当前用户工作区。

---

### Task 1: 建立可测试的扑克 UI 令牌与布局

**Files:**
- Create: `assets/scripts/ui/PokerUiTheme.ts`
- Create: `tests/ui/PokerUiTheme.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { POKER_UI, getPokerSeatLayout } from '../../assets/scripts/ui/PokerUiTheme';

describe('PokerUiTheme', () => {
  it('keeps the Pen design palette and a six-seat 1280×720 layout', () => {
    expect(POKER_UI.canvas).toEqual({ width: 1280, height: 720 });
    expect(POKER_UI.colors.background).toBe('#0B162B');
    expect(POKER_UI.colors.gold).toBe('#F5C051');
    expect(getPokerSeatLayout()).toEqual([
      { id: 'ai-1', x: 0, y: 258, name: '山雀' },
      { id: 'ai-2', x: -420, y: 168, name: 'Luna' },
      { id: 'ai-3', x: 420, y: 168, name: 'Marco' },
      { id: 'ai-4', x: 486, y: -100, name: 'Nova' },
      { id: 'ai-5', x: -486, y: -100, name: '夜航' },
      { id: 'player', x: 0, y: -276, name: '你 · VIP' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: FAIL because `PokerUiTheme.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export const POKER_UI = {
  canvas: { width: 1280, height: 720 },
  colors: {
    background: '#0B162B', panel: '#182C47', panelRaised: '#14304A',
    felt: '#217E5E', gold: '#F5C051', text: '#F0F9FF',
  },
  radii: { panel: 18, seat: 16, control: 8, card: 6 },
  actionColors: ['#AC3D49', '#2E699C', '#198E63', '#C67D24'],
} as const;

export interface PokerSeatLayout { id: string; x: number; y: number; name: string; }

export function getActionButtonSpecs() {
  return [
    { action: 'fold', color: POKER_UI.actionColors[0] },
    { action: 'call', color: POKER_UI.actionColors[1] },
    { action: 'raise', color: POKER_UI.actionColors[2] },
    { action: 'all-in', color: POKER_UI.actionColors[3] },
  ] as const;
}

export function getPokerSeatLayout(): PokerSeatLayout[] {
  return [
    { id: 'ai-1', x: 0, y: 258, name: '山雀' },
    { id: 'ai-2', x: -420, y: 168, name: 'Luna' },
    { id: 'ai-3', x: 420, y: 168, name: 'Marco' },
    { id: 'ai-4', x: 486, y: -100, name: 'Nova' },
    { id: 'ai-5', x: -486, y: -100, name: '夜航' },
    { id: 'player', x: 0, y: -276, name: '你 · VIP' },
  ];
}
```

- [ ] **Step 4: Run focused test to verify it passes**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: PASS with 1 test.

- [ ] **Step 5: Do not commit**

The repository has no initial commit; preserve the user worktree and continue without a commit.

### Task 2: 将牌桌、座位、卡牌和操作区应用主题布局

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts:1-218`
- Test: `tests/ui/PokerUiTheme.spec.ts`

- [ ] **Step 1: Add an action-button contract to the failing test**

```ts
import { getActionButtonSpecs } from '../../assets/scripts/ui/PokerUiTheme';

it('keeps the four gameplay actions in the Pen visual order', () => {
  expect(getActionButtonSpecs()).toEqual([
    { action: 'fold', color: '#AC3D49' },
    { action: 'call', color: '#2E699C' },
    { action: 'raise', color: '#198E63' },
    { action: 'all-in', color: '#C67D24' },
  ]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: FAIL because `getActionButtonSpecs` is not exported by the new theme module.

- [ ] **Step 3: Refactor GameBootstrap to consume the theme**

```ts
import { POKER_UI, getPokerSeatLayout } from '../ui/PokerUiTheme';

const TABLE_GREEN = colorHex(POKER_UI.colors.felt);
const GOLD = colorHex(POKER_UI.colors.gold);
const TEXT = colorHex(POKER_UI.colors.text);

// buildTable: use POKER_UI.canvas, panel colors and panel radius.
// createSeats: iterate getPokerSeatLayout(), show name + stack + action,
// and add a gold outline for `player`.
// createActionBar: map POKER_UI.actionColors in the existing action order.
```

Keep all existing `Node.EventType.TOUCH_END` callbacks and `PlayerAction` mapping unchanged. Extend `createRounded` with an optional stroke color/width so the table rim, inner felt and current player seat can use the Pen gold/green outlines. Update card face and back dimensions/offsets to resemble the Pen cards while preserving `showCard` and deal targets.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Run type checking**

Run: `pnpm run typecheck:game`

Expected: exit 0.

### Task 3: 对齐自定义加注遮罩与弹层层级

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts:42-214,361-405`
- Test: `tests/ui/PokerUiTheme.spec.ts`

- [ ] **Step 1: Add modal geometry to the failing test**

```ts
import { POKER_RAISE_MODAL } from '../../assets/scripts/ui/PokerUiTheme';

it('uses the Pen custom raise modal geometry', () => {
  expect(POKER_RAISE_MODAL).toEqual({ width: 620, height: 196, y: -128 });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: FAIL because `POKER_RAISE_MODAL` is not exported.

- [ ] **Step 3: Add modal constants and visual transition**

```ts
export const POKER_RAISE_MODAL = { width: 620, height: 196, y: -128 } as const;

// GameBootstrap fields
private raiseOverlay!: Node;

// buildTable
this.raiseOverlay = this.createRounded('raise-overlay', this.node, 0, 0, 1280, 720, 0, new Color(4, 13, 28, 184));
this.raiseOverlay.active = false;

// openRaisePanel / closeRaisePanel
this.raiseOverlay.active = true;
this.raisePanel.active = true;
tween(this.raisePanel).set({ position: new Vec3(0, -144, 0) }).to(0.16, { position: new Vec3(0, POKER_RAISE_MODAL.y, 0) }, { easing: 'quadOut' }).start();
```

Create the modal after the overlay so the panel is layered above it. Use `POKER_RAISE_MODAL` for the existing 620 × 196 panel, preserve numeric input and each preset callback, and only hide action buttons while the panel is active.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: PASS with 3 tests.

- [ ] **Step 5: Run the existing raise tests**

Run: `pnpm test tests/ui/RaiseAmount.spec.ts`

Expected: PASS with 2 tests; no amount behavior changes.

### Task 4: 实现结算高亮与筹码回流视觉状态

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts:287-318,326-349,485-497`
- Test: `tests/ui/PokerUiTheme.spec.ts`

- [ ] **Step 1: Add the winner-feedback contract to the failing test**

```ts
import { POKER_SHOWDOWN_FEEDBACK } from '../../assets/scripts/ui/PokerUiTheme';

it('uses a gold highlight and timed pot return for showdown feedback', () => {
  expect(POKER_SHOWDOWN_FEEDBACK).toEqual({ winnerScale: 1.06, chipDuration: 0.24 });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: FAIL because `POKER_SHOWDOWN_FEEDBACK` is not exported by the new theme module.

- [ ] **Step 3: Add visual-only showdown feedback**

```ts
export const POKER_SHOWDOWN_FEEDBACK = { winnerScale: 1.06, chipDuration: 0.24 } as const;

// In the `pot-awarded` branch of playEvents:
this.highlightWinner(event.playerId, true);
this.resultLabel.string = `${winnerName} 赢得 ${event.amount} · ${event.handName}`;
this.resultLabel.node.active = true;
await this.animateChip(new Vec3(0, 62, 0), this.seats.get(event.playerId)!.position);

private highlightWinner(id: string, active: boolean): void {
  const seat = this.seats.get(id)!;
  // Set the existing outline node to POKER_UI.colors.gold and tween seat scale
  // to 1.06 before returning it to the render-controlled scale.
}
```

Create one reusable outline child on every seat in `createSeats`; only activate it for the current player or temporary winner. Clear temporary winner state in `resetVisuals`. Do not change the `EngineEvent` ordering or restart timing.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test tests/ui/PokerUiTheme.spec.ts`

Expected: PASS with 4 tests.

- [ ] **Step 5: Run all tests and type checking**

Run: `pnpm run typecheck:game && pnpm test`

Expected: exit 0; all existing core, AI and raise tests remain green.

### Task 5: Cocos Creator 1280 × 720 visual QA

**Files:**
- Verify: `assets/scenes/Game.scene`
- Verify: `assets/scripts/bootstrap/GameBootstrap.ts`

- [ ] **Step 1: Open the project in Cocos Creator**

Use Cocos Creator’s project-open UI for `/Users/andrew/Documents/Codex/2026-08-12/vip/texas-holdem` and open `assets/scenes/Game.scene`.

- [ ] **Step 2: Run the scene and inspect the main state**

Verify the 1280 × 720 preview has no cropped top bar or action bar; it shows six seats, the double-rim oval table, the central pot/community region, player cards and four color-coded action buttons.

- [ ] **Step 3: Inspect the raise state**

Trigger `自定义加注` when it is the player’s turn. Verify the 620 × 196 modal appears above a dark overlay, numeric input and all six presets are readable, cancel restores actions, and confirm sends the same legal raise through the engine.

- [ ] **Step 4: Inspect showdown**

Play or wait through a resolved hand. Verify community cards and showdown cards reveal; winner message, gold seat outline and pot-to-winner chip movement render before the next hand begins.

- [ ] **Step 5: Record verification without committing**

Run `pnpm run typecheck:game && pnpm test` one final time and report the exact result. Do not create a Git commit or PR in the unborn repository.
