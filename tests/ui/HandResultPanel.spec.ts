import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandResultPanel } from '../../assets/scripts/ui/HandResultPanel';
import { buildHandResult } from '../../assets/scripts/ui/HandResultModel';

class Element {
  children: Element[] = []; parent: Element | null = null; className = ''; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; tabIndex = 0; disabled = false; type = '';
  private ownText = ''; onclick: (() => void) | null = null; onkeydown: ((event: any) => void) | null = null; listeners: Record<string, ((event: any) => void)[]> = {};
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = value; this.children.forEach(child => child.parent = null); this.children = []; }
  get isConnected(): boolean { return this === doc.body || this === doc.head || Boolean(this.parent?.isConnected); }
  appendChild(child: Element): Element { child.parent = this; this.children.push(child); return child; }
  append(...children: Element[]): void { children.forEach(child => this.appendChild(child)); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(type: string, listener: (event: any) => void): void { (this.listeners[type] ??= []).push(listener); }
  focus(): void { doc.activeElement = this; }
  contains(node: Element): boolean { return node === this || nodes(this).includes(node); }
  querySelectorAll(): Element[] { return nodes(this).filter(node => node.type === 'button' && !node.disabled); }
}
let doc: { body: Element; head: Element; activeElement: Element; createElement(tag: string): Element; getElementById(id: string): Element | null };
function nodes(root: Element): Element[] { return root.children.flatMap(child => [child, ...nodes(child)]); }
function action(name: string): Element { const node = nodes(doc.body).find(item => item.dataset.action === name); expect(node, name).toBeDefined(); return node!; }
const result = () => buildHandResult(3, [{ playerId: 'me', amount: 1000, handName: '同花' }, { playerId: 'other', amount: 250, handName: '顺子' }], [{ id: 'me', name: '<img src=x onerror=evil()>' }, { id: 'other', name: '另一位玩家完整昵称' }], 'me', -100);
let panel: HandResultPanel; let onSkip: ReturnType<typeof vi.fn>; let onClose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  doc = { body: new Element(), head: new Element(), activeElement: new Element(), createElement: () => new Element(), getElementById: id => nodes(doc.head).find(node => node.attributes.id === id) ?? null };
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', Element);
  onSkip = vi.fn(); onClose = vi.fn(); panel = new HandResultPanel({ onSkip, onClose });
});
afterEach(() => { panel.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('hand result presentation', () => {
  it('shows every full winner name as text and distinguishes payouts from optional net change', () => {
    panel.show(result(), { canSkip: true, seconds: 5 });
    expect(doc.body.textContent).toContain('<img src=x onerror=evil()>');
    expect(doc.body.textContent).toContain('另一位玩家完整昵称');
    expect(doc.body.textContent).toContain('1,000');
    expect(doc.body.textContent).toContain('本手净变化');
    expect(doc.body.textContent).toContain('-100');
    expect(doc.body.textContent).toContain('含本手投入');
    expect(nodes(doc.body).find(node => node.attributes.role === 'dialog')?.attributes['aria-modal']).toBe('true');
  });

  it('updates display seconds without replacing content or triggering next hand by itself', () => {
    panel.show(result(), { canSkip: true, seconds: 5 }); const skip = action('hand-result-skip'); skip.focus();
    panel.updateSeconds(3); vi.advanceTimersByTime(6000);
    expect(doc.body.textContent).toContain('3 秒');
    expect(action('hand-result-skip')).toBe(skip); expect(doc.activeElement).toBe(skip);
    expect(onSkip).not.toHaveBeenCalled();
    skip.onclick?.(); skip.onclick?.();
    expect(onSkip).toHaveBeenCalledOnce(); expect(panel.isOpen).toBe(false);
    expect(nodes(doc.body).some(node => node.className === 'poker-hand-result-input-shield')).toBe(true);
    vi.advanceTimersByTime(300); expect(doc.body.children).toHaveLength(0);
  });

  it('history is read-only, omits an invented timer and restores focus on Escape', () => {
    const origin = new Element(); doc.body.appendChild(origin); origin.focus();
    const withoutNet = buildHandResult(1, [{ playerId: 'me', amount: 40, handName: '未摊牌' }], [{ id: 'me', name: '你' }], 'me');
    panel.show(withoutNet, { canSkip: false });
    expect(nodes(doc.body).some(node => node.dataset.action === 'hand-result-skip')).toBe(false);
    expect(doc.body.textContent).not.toContain('本手净变化'); expect(doc.body.textContent).not.toContain('秒');
    const overlay = nodes(doc.body).find(node => node.className === 'poker-hand-result-overlay')!;
    const event = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() }; overlay.onkeydown?.(event);
    expect(onClose).toHaveBeenCalledOnce(); expect(onSkip).not.toHaveBeenCalled(); expect(doc.activeElement).toBe(origin);
  });

  it('silent lifecycle close and destroy cannot dispatch stale button callbacks', () => {
    panel.show(result(), { canSkip: true, seconds: 5 }); const old = action('hand-result-skip');
    panel.close(); old.onclick?.(); expect(onSkip).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    panel.show(result(), { canSkip: false }); action('hand-result-close').onclick?.(); expect(onClose).toHaveBeenCalledOnce();
    panel.destroy(); expect(doc.body.children).toHaveLength(0);
  });
});
