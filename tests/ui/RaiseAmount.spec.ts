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
