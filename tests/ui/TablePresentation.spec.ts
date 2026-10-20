import { describe, expect, it, vi } from 'vitest';
import { formatSeatName, formatTableChips, getActionPresentation } from '../../assets/scripts/ui/TablePresentation';

describe('table data presentation', () => {
  it('keeps ordinary table amounts readable and exact', () => {
    expect(formatTableChips(0)).toEqual({ display: '0', full: '0' });
    expect(formatTableChips(999999, true)).toEqual({ display: '999,999', full: '999,999' });
    expect(formatTableChips(1234567)).toEqual({ display: '1,234,567', full: '1,234,567' });
  });
  it('compacts only large non-action amounts while retaining every original digit', () => {
    expect(formatTableChips(1000000, true)).toEqual({ display: '100万', full: '1,000,000' });
    expect(formatTableChips(1234567, true)).toEqual({ display: '123.46万', full: '1,234,567' });
    expect(formatTableChips(123450000, true)).toEqual({ display: '1.23亿', full: '123,450,000' });
    expect(formatTableChips(100000000, true).display).toBe('1亿');
    expect(formatTableChips(Number.MAX_SAFE_INTEGER, true).full).toBe('9,007,199,254,740,991');
  });
  it.each([-1, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('does not expose invalid chips %s', amount => {
    expect(formatTableChips(amount, true)).toEqual({ display: '—', full: '—' });
  });
  it('splits labels and exact chip commitments without compacting or rounding', () => {
    expect(getActionPresentation({ type: 'call', amount: 1234567 }, 5000000)).toEqual({ title: '跟注', detail: '1,234,567', accessibleText: '跟注 1,234,567' });
    expect(getActionPresentation({ type: 'all-in' }, 9007199254740991)).toEqual({ title: '全压', detail: '9,007,199,254,740,991', accessibleText: '全压 9,007,199,254,740,991' });
    expect(getActionPresentation({ type: 'raise', to: 80 }, 5000)).toEqual({ title: '加注', detail: '自定义金额', accessibleText: '加注 自定义金额' });
  });
  it('provides stable labels for check, fold and a disabled slot', () => {
    expect(getActionPresentation({ type: 'check' }, 5000)).toEqual({ title: '过牌', detail: '无需投入', accessibleText: '过牌 无需投入' });
    expect(getActionPresentation({ type: 'fold' }, 5000)).toEqual({ title: '弃牌', detail: '放弃本手', accessibleText: '弃牌 放弃本手' });
    expect(getActionPresentation(null, 5000)).toEqual({ title: '等待', detail: '—', accessibleText: '等待' });
    expect(getActionPresentation({ type: 'all-in' }, NaN).detail).toBe('—');
  });
  it('keeps joined emoji, flags and combining marks intact without Intl.Segmenter', () => {
    vi.stubGlobal('Intl', {});
    try {
      expect(formatSeatName('👨‍👩‍👧‍👦🇨🇳e\u0301更多', 4).display).toBe('👨‍👩‍👧‍👦🇨🇳e\u0301…');
      expect(formatSeatName('👍🏽👍🏻abc', 3).display).toBe('👍🏽👍🏻…');
    } finally { vi.unstubAllGlobals(); }
  });
  it('retains the exact original name and shortens whole graphemes only', () => {
    expect(formatSeatName('山雀')).toEqual({ display: '山雀', full: '山雀' });
    expect(formatSeatName('abcdefghijklmnop')).toEqual({ display: 'abcdefghijk…', full: 'abcdefghijklmnop' });
    expect(formatSeatName('👨‍👩‍👧‍👦🇨🇳e\u0301更多', 4)).toEqual({ display: '👨‍👩‍👧‍👦🇨🇳e\u0301…', full: '👨‍👩‍👧‍👦🇨🇳e\u0301更多' });
    expect(formatSeatName('𠮷野家', 2).display).toBe('𠮷…');
    expect(formatSeatName('ab', 1).display).toBe('…');
    expect(formatSeatName('ab', NaN).display).toBe('ab');
  });
});
