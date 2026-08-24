# 自定义加注金额 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许玩家在 Cocos 德州扑克桌上用输入、步进和快捷档位选择任意合法的加注总额。

**Architecture:** 新增纯函数模块处理最小值、上限、20 筹码步进和四种快捷金额；规则引擎继续裁决 `{ type: 'raise', to }`。`GameBootstrap` 只渲染加注面板、把玩家输入转换为纯函数的候选值，并在确认时执行引擎已验证的加注动作。

**Tech Stack:** TypeScript、Vitest、Cocos Creator 3.8.8 UI (`Node`、`Label`、`EditBox`)。

---

## File structure

- Create: `assets/scripts/ui/RaiseAmount.ts` — 金额范围、规范化和快捷档位的纯函数。
- Create: `tests/ui/RaiseAmount.spec.ts` — 纯函数边界与档位测试。
- Modify: `tests/core/PokerEngine.spec.ts` — 自定义 `raise.to` 的引擎回归测试。
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts` — 加注面板、数值输入、快捷按钮和确认/取消流程。
- Modify: `README.md` — 玩家操作说明。

### Task 1: 自定义金额纯函数

**Files:**
- Create: `assets/scripts/ui/RaiseAmount.ts`
- Test: `tests/ui/RaiseAmount.spec.ts`

- [ ] **Step 1: 写失败的金额规范化测试**

```ts
import { describe, expect, it } from 'vitest';
import { chooseRaisePreset, normalizeRaiseTo, RaiseBounds } from '../../assets/scripts/ui/RaiseAmount';

const bounds: RaiseBounds = {
  minTo: 120,
  maxTo: 500,
  pot: 200,
  toCall: 40,
  streetContribution: 40,
  step: 20,
};

describe('custom raise amount', () => {
  it('clamps direct input and keeps full all-in amounts', () => {
    expect(normalizeRaiseTo(95, bounds)).toBe(120);
    expect(normalizeRaiseTo(319, bounds)).toBe(300);
    expect(normalizeRaiseTo(999, { ...bounds, maxTo: 505 })).toBe(505);
  });

  it('derives minimum, half-pot, pot and all-in shortcuts', () => {
    expect(chooseRaisePreset('minimum', bounds)).toBe(120);
    expect(chooseRaisePreset('half-pot', bounds)).toBe(180);
    expect(chooseRaisePreset('pot', bounds)).toBe(280);
    expect(chooseRaisePreset('all-in', bounds)).toBe(500);
  });
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `pnpm exec vitest run tests/ui/RaiseAmount.spec.ts`

Expected: FAIL with `Failed to load url ../../assets/scripts/ui/RaiseAmount`.

- [ ] **Step 3: 实现最小金额模块**

```ts
export interface RaiseBounds {
  minTo: number;
  maxTo: number;
  pot: number;
  toCall: number;
  streetContribution: number;
  step: number;
}

export type RaisePreset = 'minimum' | 'half-pot' | 'pot' | 'all-in';

export function normalizeRaiseTo(candidate: number, bounds: RaiseBounds): number {
  const capped = Math.min(Math.max(Number.isFinite(candidate) ? candidate : bounds.minTo, bounds.minTo), bounds.maxTo);
  if (capped === bounds.maxTo) {
    return capped;
  }

  const stepped = Math.floor(capped / bounds.step) * bounds.step;
  return Math.max(bounds.minTo, stepped);
}

export function chooseRaisePreset(preset: RaisePreset, bounds: RaiseBounds): number {
  const base = bounds.streetContribution + bounds.toCall;
  const candidate = preset === 'minimum' ? bounds.minTo
    : preset === 'half-pot' ? base + bounds.pot / 2
      : preset === 'pot' ? base + bounds.pot
        : bounds.maxTo;
  return normalizeRaiseTo(candidate, bounds);
}
```

- [ ] **Step 4: 运行纯函数测试确认通过**

Run: `pnpm exec vitest run tests/ui/RaiseAmount.spec.ts`

Expected: PASS with 2 tests.

### Task 2: 规则引擎接受自定义合法加注

**Files:**
- Modify: `tests/core/PokerEngine.spec.ts`
- Modify: `assets/scripts/core/PokerEngine.ts` only if this test exposes a rule-engine defect.

- [ ] **Step 1: 写失败的引擎行为测试**

Append this test inside the existing `describe('PokerEngine', ...)` block:

```ts
it('accepts a raise amount above the minimum when the player can cover it', () => {
  const game = engine();
  game.startHand();

  const events = game.act({ type: 'raise', to: 160 });

  expect(events).toContainEqual(expect.objectContaining({
    type: 'action-taken',
    playerId: 'ai-4',
    action: { type: 'raise', to: 160 },
    amount: 160,
  }));
  expect(game.snapshot().players.find(({ id }) => id === 'ai-4')).toMatchObject({
    streetContribution: 160,
    stack: 4840,
  });
});
```

- [ ] **Step 2: 运行测试，确认现有规则的结果**

Run: `pnpm exec vitest run tests/core/PokerEngine.spec.ts`

Expected: the new test passes; this is a regression lock for the already-supported legal `{ type: 'raise', to }` API. If it fails, record the failure and change only `PokerEngine.ts` enough to meet the assertion.

- [ ] **Step 3: 运行全部核心测试**

Run: `pnpm exec vitest run tests/core`

Expected: PASS with no test failures.

### Task 3: Cocos 自定义加注面板

**Files:**
- Modify: `assets/scripts/bootstrap/GameBootstrap.ts`

- [ ] **Step 1: 导入金额模块与 `EditBox`，并增加面板状态**

Add these imports and fields:

```ts
import { EditBox } from 'cc';
import { chooseRaisePreset, normalizeRaiseTo, RaiseBounds, RaisePreset } from '../ui/RaiseAmount';

private raisePanel!: Node;
private raiseAmountLabel!: Label;
private raiseInput!: EditBox;
private selectedRaiseTo = 0;
```

- [ ] **Step 2: 创建可复用加注面板**

Call `this.createRaisePanel()` from `buildTable()` after `createActionBar()`. Add `createRaisePanel()` that creates an inactive panel above the action bar, an `EditBox` configured with `EditBox.InputMode.NUMERIC`, six buttons labelled `−20`、`+20`、`最小`、`半池`、`满池`、`全压`, and `取消`、`确认加注` buttons. Each button must call one of:

```ts
private adjustRaiseAmount(delta: number): void {
  this.setRaiseAmount(this.selectedRaiseTo + delta);
}

private applyRaisePreset(preset: RaisePreset): void {
  this.setRaiseAmount(chooseRaisePreset(preset, this.getRaiseBounds()));
}

private setRaiseAmount(candidate: number): void {
  this.selectedRaiseTo = normalizeRaiseTo(candidate, this.getRaiseBounds());
  this.raiseAmountLabel.string = `加注至 ${this.selectedRaiseTo}`;
  this.raiseInput.string = String(this.selectedRaiseTo);
}
```

For the input end-edit callback, parse the field with `Number(this.raiseInput.string)` and pass it to `setRaiseAmount`.

- [ ] **Step 3: 从当前快照计算金额边界**

Add this method to `GameBootstrap`:

```ts
private getRaiseBounds(): RaiseBounds {
  const state = this.engine.snapshot();
  const player = state.players.find(({ id }) => id === 'player')!;
  const minimum = state.legalActions.find((action) => action.type === 'raise');

  if (!minimum || minimum.type !== 'raise') {
    throw new Error('No legal raise is available');
  }

  return {
    minTo: minimum.to,
    maxTo: player.streetContribution + player.stack,
    pot: state.pot,
    toCall: state.legalActions.find((action) => action.type === 'call')?.amount ?? 0,
    streetContribution: player.streetContribution,
    step: 20,
  };
}
```

- [ ] **Step 4: 替换原“加注”按钮的动作流程**

In `renderActionButtons`, replace the ordinary raise action button with a panel-opening button when it is the player’s legal raise. Its callback should call `openRaisePanel()`, which initializes the amount to `getRaiseBounds().minTo` and hides the ordinary action buttons. The confirm button must run:

```ts
private async confirmRaise(): Promise<void> {
  const to = normalizeRaiseTo(Number(this.raiseInput.string), this.getRaiseBounds());
  this.raisePanel.active = false;
  await this.handlePlayerAction({ type: 'raise', to });
}
```

The cancel button sets `this.raisePanel.active = false` and calls `this.render()` without invoking `engine.act`.

- [ ] **Step 5: 静态检查 UI 脚本**

Run: `pnpm run typecheck:game`

Expected: PASS with no TypeScript diagnostics.

### Task 4: 全量验证与说明

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 补充操作说明**

Under the existing player-action paragraph, add:

```md
选择“自定义加注”可直接输入总下注额、用 `−20 / +20` 调整，或选择最小、半池、满池、全压档位；确认前不会改变牌局。
```

- [ ] **Step 2: 运行静态检查与完整自动测试**

Run: `pnpm run typecheck:game && pnpm test`

Expected: PASS; report the exact test-file and assertion counts.

- [ ] **Step 3: 运行 Cocos 预览并执行交互验收**

Open `assets/scenes/Game.scene` in Cocos Creator, set it as the preview scene, then verify at 1280 × 720:

1. 点击“自定义加注”后，面板包含输入、`−20/+20`、最小、半池、满池、全压、取消和确认。
2. 对每一种金额选择方式，显示金额保持在最小加注和全压上限内。
3. 点击取消后玩家仍在同一行动回合；点击确认后牌局前进、桌面筹码移动、底池刷新。

- [ ] **Step 4: 检查工作区而不提交**

Run: `git status --short`

Expected: list all generated project files. Do not commit because this generated project has no initial commit and the user has not requested a commit.
