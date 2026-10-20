import type { PlayerAction } from '../core/types';

export interface ChipPresentation {
  display: string;
  /** Exact, grouped integer, also available when the visual label is compact. */
  full: string;
}

/** Compact labels are for balances/pots only; action commitments always use full. */
export function formatTableChips(amount: number, compact = false): ChipPresentation {
  if (!Number.isSafeInteger(amount) || amount < 0) return { display: '—', full: '—' };
  const full = String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (!compact || amount < 1000000) return { display: full, full };
  const divisor = amount >= 100000000 ? 100000000 : 10000;
  const suffix = divisor === 100000000 ? '亿' : '万';
  const abbreviated = (amount / divisor).toFixed(2).replace(/\.?0+$/, '');
  return { display: abbreviated + suffix, full };
}

export interface ActionPresentation {
  title: string;
  detail: string;
  accessibleText: string;
}

/** Separate lines let the renderer shrink the amount without losing any digits. */
export function getActionPresentation(action: PlayerAction | null, stack: number): ActionPresentation {
  if (!action) return { title: '等待', detail: '—', accessibleText: '等待' };
  let title: string;
  let detail: string;
  switch (action.type) {
    case 'fold': title = '弃牌'; detail = '放弃本手'; break;
    case 'check': title = '过牌'; detail = '无需投入'; break;
    case 'call': title = '跟注'; detail = formatTableChips(action.amount).full; break;
    case 'raise': title = '加注'; detail = '自定义金额'; break;
    case 'all-in': title = '全压'; detail = formatTableChips(stack).full; break;
  }
  return { title, detail, accessibleText: `${title} ${detail}` };
}

interface GraphemeSegment { segment: string }
interface GraphemeSegmenter { segment(value: string): Iterable<GraphemeSegment> }

function graphemes(name: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string, options?: { granularity: string }) => GraphemeSegmenter;
  }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(name), part => part.segment);
  // Older browsers: keep common combining marks, emoji modifiers and ZWJ chains together.
  const result: string[] = [];
  let joinNext = false;
  let regionalCount = 0;
  Array.from(name).forEach(character => {
    const point = character.codePointAt(0)!;
    const regional = point >= 0x1f1e6 && point <= 0x1f1ff;
    const extending = (point >= 0x300 && point <= 0x36f)
      || (point >= 0x1ab0 && point <= 0x1aff) || (point >= 0x1dc0 && point <= 0x1dff)
      || (point >= 0x20d0 && point <= 0x20ff) || (point >= 0xfe00 && point <= 0xfe0f)
      || (point >= 0xfe20 && point <= 0xfe2f) || (point >= 0x1f3fb && point <= 0x1f3ff)
      || (point >= 0xe0100 && point <= 0xe01ef);
    if (result.length && (joinNext || extending || point === 0x200d || (regional && regionalCount % 2 === 1))) {
      result[result.length - 1] += character;
    } else result.push(character);
    joinNext = point === 0x200d;
    regionalCount = regional ? regionalCount + 1 : 0;
  });
  return result;
}

export function formatSeatName(name: string, maxChars = 12): { display: string; full: string } {
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 12;
  const characters = graphemes(name);
  return { display: characters.length <= limit ? name : characters.slice(0, limit - 1).join('') + '…', full: name };
}
