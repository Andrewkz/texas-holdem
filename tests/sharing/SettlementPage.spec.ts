import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePublicSettlement, renderPublicSettlement } from '../../build-templates/web-desktop/settlement.js';
function settlement() { return { sessionId:'session-a',shareId:'A'.repeat(32),endedAt:1000,expiresAt:1000+30*86400000,reason:'host-ended',recoveryNotice:null,rows:[{playerId:'p1',nickname:'A',rebuyCount:1,totalBuyIn:10000,finalChips:7000,net:-3000},{playerId:'p2',nickname:'B',rebuyCount:0,totalBuyIn:5000,finalChips:8000,net:3000}] }; }
describe('standalone readonly settlement payload', () => {
  it('accepts exactly the public fixed zero-sum projection', () => { const raw=settlement();expect(parsePublicSettlement(raw)).toEqual(raw); });
  it.each(['token','tokenHash','cards','credentials','checkpoint'])('rejects unexpected secret/internal top field %s', field => { expect(parsePublicSettlement({...settlement(),[field]:'known-secret'})).toBeNull(); });
  it('rejects hidden row fields and conflicting or duplicated identities', () => {
    const raw=settlement();expect(parsePublicSettlement({...raw,rows:[{...raw.rows[0],token:'known-secret'},raw.rows[1]]})).toBeNull();
    expect(parsePublicSettlement({...raw,rows:[raw.rows[0],{...raw.rows[1],playerId:'p1'}]})).toBeNull();
  });
  it.each([NaN,Infinity,-1,1.1,Number.MAX_SAFE_INTEGER+1])('rejects invalid chip values %s', finalChips => {const raw=settlement();raw.rows[0].finalChips=finalChips;expect(parsePublicSettlement(raw)).toBeNull();});
  it('rejects forged net, non-zero total, wrong rebuy accounting or variable expiry', () => {
    const raw=settlement();expect(parsePublicSettlement({...raw,rows:[{...raw.rows[0],net:0},raw.rows[1]]})).toBeNull();
    expect(parsePublicSettlement({...raw,rows:[{...raw.rows[0],net:-3001,finalChips:6999},raw.rows[1]]})).toBeNull();
    expect(parsePublicSettlement({...raw,rows:[{...raw.rows[0],rebuyCount:0},raw.rows[1]]})).toBeNull();
    expect(parsePublicSettlement({...raw,expiresAt:raw.expiresAt+1})).toBeNull();
  });
  it('accepts a scoped recovery explanation and rejects added private data', () => {
    const raw={...settlement(),recoveryNotice:{sessionId:'session-a',tableEpoch:'new-runtime',checkpointVersion:2,rolledBackHandId:3,reason:'server-restart'}};
    expect(parsePublicSettlement(raw)).toEqual(raw);
    expect(parsePublicSettlement({...raw,recoveryNotice:{...raw.recoveryNotice,token:'known-secret'}})).toBeNull();
    expect(parsePublicSettlement({...raw,recoveryNotice:{...raw.recoveryNotice,sessionId:'other'}})).toBeNull();
  });
});


class PageElement {
  children: PageElement[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  value = '';
  readOnly = false;
  selected = false;
  private text = '';
  onclick: (() => Promise<void> | void) | null = null;
  constructor(public tagName: string) {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  appendChild(child: PageElement): PageElement { this.children.push(child); return child; }
  append(...children: PageElement[]): void { this.children.push(...children); }
  replaceChildren(...children: PageElement[]): void { this.text = ''; this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  focus(): void {}
  select(): void { this.selected = true; }
}
function nodes(element: PageElement): PageElement[] { return [element, ...element.children.flatMap(nodes)]; }
afterEach(() => { vi.unstubAllGlobals(); });
describe('standalone settlement rendering', () => {
  it('copies the full public URL on HTTP through the selected link field', async () => {
    let selected: PageElement | null = null, copied = '';
    vi.stubGlobal('document', {
      createElement: (tag: string) => { const element = new PageElement(tag); element.focus = () => { selected = element; }; return element; },
      execCommand: (command: string) => { if (command !== 'copy' || !selected?.selected) return false; copied = selected.value; return true; },
    });
    vi.stubGlobal('navigator', {});
    const content = new PageElement('section');
    renderPublicSettlement(content, settlement(), 'http://poker.test/settlement.html?share=public-link');
    await nodes(content).find(node => node.dataset.action === 'copy-share')!.onclick?.();
    expect(copied).toBe('http://poker.test/settlement.html?share=public-link');
    expect(content.textContent).toContain('已复制'); expect(content.textContent).not.toContain('手动复制');
  });
  it('preserves readable row headings, literal nicknames and honest copy failure after the visual refresh', async () => {
    vi.stubGlobal('document', { createElement: (tag: string) => new PageElement(tag) });
    vi.stubGlobal('navigator', {});
    const content = new PageElement('section'), data = settlement();
    data.rows[0].nickname = '<b>A</b>';
    renderPublicSettlement(content, data, 'https://poker.test/settlement.html?share=' + data.shareId);
    const rendered = nodes(content);
    expect(rendered.filter(node => node.tagName === 'th').every(node => node.attributes.scope === 'col')).toBe(true);
    expect(rendered.find(node => node.tagName === 'td' && node.textContent === '<b>A</b>')).toBeDefined();
    expect(rendered.some(node => node.tagName === 'b')).toBe(false);
    expect(rendered.find(node => node.tagName === 'td' && node.textContent === '-3,000')?.attributes['data-label']).toBe('净盈亏');
    const copy = rendered.find(node => node.dataset.action === 'copy-share')!;
    await copy.onclick?.();
    expect(content.textContent).toContain('手动复制');
    expect(rendered.find(node => node.tagName === 'input')?.selected).toBe(true);
  });
});
