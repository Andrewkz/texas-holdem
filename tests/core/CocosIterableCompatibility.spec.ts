import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const cocosBabelModules = [
  process.env.COCOS_BABEL_MODULES,
  '/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/Resources/resources/3d/engine/node_modules',
].find(candidate => candidate && existsSync(resolve(candidate, '@babel/core')));

// This environment check exercises the installed Cocos toolchain without adding a runtime dependency.
// COCOS_BABEL_MODULES can point to another Creator installation's engine/node_modules directory.
describe.skipIf(!cocosBabelModules)('Cocos loose spread compatibility', () => {
  function compiledModule(path: string, cache = new Map<string, { exports: any }>()): any {
    const absolute = resolve(path);
    if (cache.has(absolute)) return cache.get(absolute)!.exports;
    const babel = require(resolve(cocosBabelModules!, '@babel/core'));
    const spread = require(resolve(cocosBabelModules!, '@babel/plugin-transform-spread'));
    const code = ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const transformed = babel.transformSync(code, {
      babelrc: false, configFile: false, plugins: [[spread, { loose: true }]],
    }).code;
    const module = { exports: {} };
    cache.set(absolute, module);
    runInNewContext(transformed, {
      module, exports: module.exports,
      require: (dependency: string) => compiledModule(resolve(dirname(absolute), `${dependency}.ts`), cache),
    }, { filename: absolute });
    return module.exports;
  }

  const card = (rank: number, suit: string) => ({ rank, suit });

  it('retains finite main and side pots after the same loose spread transform as Creator', () => {
    const { buildPots } = compiledModule('assets/scripts/core/SidePot.ts');
    expect(buildPots([
      { playerId: 'a', amount: 40, folded: false },
      { playerId: 'b', amount: 120, folded: false },
      { playerId: 'c', amount: 120, folded: false },
    ])).toEqual([
      { amount: 120, eligiblePlayerIds: ['a', 'b', 'c'] },
      { amount: 160, eligiblePlayerIds: ['b', 'c'] },
    ]);
  });

  it('retains pair and ace-low straight evaluation after the loose transform', () => {
    const { evaluateBest, HandCategory } = compiledModule('assets/scripts/core/HandEvaluator.ts');
    expect(evaluateBest([card(14, 'S'), card(14, 'H'), card(2, 'D'), card(7, 'C'), card(9, 'D')]).category)
      .toBe(HandCategory.Pair);
    expect(evaluateBest([card(14, 'S'), card(2, 'H'), card(3, 'D'), card(4, 'C'), card(5, 'D')]).category)
      .toBe(HandCategory.Straight);
  });

  it('retains visible top, middle and bottom pair comparisons after the loose transform', () => {
    const { assessVisibleHand } = compiledModule('assets/scripts/ai/AiHandStrength.ts');
    const board = [card(13, 'C'), card(9, 'H'), card(4, 'S')];
    const top = assessVisibleHand([card(13, 'S'), card(2, 'D')], board, 'flop').madeStrength;
    const middle = assessVisibleHand([card(9, 'S'), card(2, 'D')], board, 'flop').madeStrength;
    const bottom = assessVisibleHand([card(4, 'C'), card(2, 'D')], board, 'flop').madeStrength;
    expect(top).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(bottom);
  });

  it('still recognizes an unbeatable shared royal board after the loose transform', () => {
    const { assessVisibleHand } = compiledModule('assets/scripts/ai/AiHandStrength.ts');
    const value = assessVisibleHand([card(2, 'C'), card(7, 'D')],
      [card(10, 'H'), card(11, 'H'), card(12, 'H'), card(13, 'H'), card(14, 'H')], 'river');
    expect(value.boardOnly).toBe(true);
    expect(value.sharedNuts).toBe(true);
  });
});
