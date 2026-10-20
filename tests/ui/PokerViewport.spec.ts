import { describe, expect, it } from 'vitest';
import { getPokerViewport } from '../../assets/scripts/ui/PokerViewport';
describe('PokerViewport', () => {
  it.each([[667,375],[844,390]])('fits landscape %sx%s with real 44px touch controls', (w,h) => {
    const v=getPokerViewport(w,h);
    expect(v.compact).toBe(true);
    const scale=Math.min(w/v.designWidth,h/v.designHeight);
    expect(v.actionHeight*scale).toBeGreaterThanOrEqual(44);
    expect(v.designHeight).toBeGreaterThan(0);
    expect(v.designHeight*scale).toBeLessThanOrEqual(h+0.01);
    expect(v.designWidth*scale).toBeLessThanOrEqual(w+0.01);
  });
  it.each([[1280,720],[1440,900]])('preserves desktop baseline %sx%s', (w,h) => {
    expect(getPokerViewport(w,h)).toMatchObject({designWidth:1280,designHeight:720,compact:false});
  });
  it('handles invalid/portrait inputs without nonfinite geometry', () => {
    for(const [w,h] of [[0,0],[NaN,Infinity],[390,844]]) {
      const v=getPokerViewport(w,h);
      expect(Number.isFinite(v.actionHeight)).toBe(true);
      expect(v.designHeight).toBeGreaterThan(0);
      expect(v.compact).toBe(false);
    }
  });
});

it('keeps 44px actions after desktop page insets reduce the rendered canvas', () => {
  const v = getPokerViewport(1232, 672);
  expect(v.actionHeight * Math.min(1232 / v.designWidth, 672 / v.designHeight)).toBeGreaterThanOrEqual(44);
});
