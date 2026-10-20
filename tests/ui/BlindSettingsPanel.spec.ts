import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlindSettingsPanel } from '../../assets/scripts/ui/BlindSettingsPanel';

class Element {
  children: Element[] = []; parent: Element | null = null; className = ''; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  disabled = false; value = ''; type = ''; tabIndex = 0; private text = '';
  onclick: (() => void) | null = null; oninput: (() => void) | null = null; onkeydown: ((event: any) => void) | null = null;
  listeners: Record<string, ((event: any) => void)[]> = {};
  constructor(public tag = 'div') {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get isConnected(): boolean { return this === doc.body || this === doc.head || Boolean(this.parent?.isConnected); }
  appendChild(child: Element): Element { child.parent = this; this.children.push(child); return child; }
  append(...children: Element[]): void { children.forEach(child => this.appendChild(child)); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, listener: (event: any) => void): void { (this.listeners[name] ??= []).push(listener); }
  focus(): void { doc.activeElement = this; }
  blur(): void { doc.activeElement = doc.body; }
  contains(node: Element): boolean { return node === this || nodes(this).includes(node); }
  querySelectorAll(): Element[] { return nodes(this).filter(n => ['button', 'input'].includes(n.tag) && !n.disabled); }
}
class Input extends Element {}
let doc: { body: Element; head: Element; activeElement: Element; createElement(tag: string): Element; getElementById(id: string): Element | null };
function nodes(root: Element): Element[] { return root.children.flatMap(child => [child, ...nodes(child)]); }
function node(action: string): Element { const result = nodes(doc.body).find(n => n.dataset.action === action); expect(result, action).toBeDefined(); return result!; }
function click(action: string): void { const target = node(action); if (!target.disabled) target.onclick?.(); }
function input(action: string, value: string): void { const target = node(action); target.value = value; target.oninput?.(); }
function shield(): Element | undefined { return doc.body.children.find(n => n.className === 'poker-blinds-shield'); }
let panel: BlindSettingsPanel, onConfirm: ReturnType<typeof vi.fn>, onClose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); doc = { body: new Element('body'), head: new Element('head'), activeElement: new Element(), createElement: tag => tag === 'input' ? new Input(tag) : new Element(tag), getElementById: id => [...nodes(doc.body), ...nodes(doc.head)].find(n => n.attributes.id === id) ?? null };
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('HTMLInputElement', Input);
  onConfirm = vi.fn(); onClose = vi.fn(); panel = new BlindSettingsPanel({ onConfirm, onClose });
});
afterEach(() => { panel.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('blind settings draft and confirmation', () => {
  it('opens with the selected stakes and commits a preset only after explicit confirmation', () => {
    const initial = { smallBlind: 20, bigBlind: 40 }; panel.open(initial);
    expect(node('blinds-small').value).toBe('20'); expect(node('blinds-big').value).toBe('40'); click('blinds-preset-50-100');
    expect(node('blinds-small').value).toBe('50'); expect(node('blinds-big').value).toBe('100'); expect(onConfirm).not.toHaveBeenCalled(); expect(initial).toEqual({ smallBlind: 20, bigBlind: 40 });
    const oldConfirm = node('blinds-confirm'); click('blinds-confirm'); oldConfirm.onclick?.(); expect(onConfirm).toHaveBeenCalledOnce(); expect(onConfirm).toHaveBeenCalledWith({ smallBlind: 50, bigBlind: 100 }); expect(onClose).toHaveBeenCalledOnce(); expect(panel.isOpen).toBe(false);
  });
  it.each([['', '40'], ['0', '40'], ['20', '20'], ['40', '20'], ['1.5', '40'], ['1e2', '200'], ['20', '1001'], ['Infinity', '1000']])('rejects invalid small %s / big %s without saving', (small, big) => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); input('blinds-small', small); input('blinds-big', big);
    expect(node('blinds-confirm').disabled).toBe(true); expect(doc.body.textContent).toContain('小盲 < 大盲 ≤ 1,000'); click('blinds-confirm'); expect(onConfirm).not.toHaveBeenCalled(); expect(panel.isOpen).toBe(true);
  });
  it('revalidates current input at confirmation even before an input event and recovers after correction', () => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); const confirm = node('blinds-confirm'); node('blinds-big').value = '1001';
    confirm.onclick?.(); expect(onConfirm).not.toHaveBeenCalled(); expect(panel.isOpen).toBe(true); expect(confirm.disabled).toBe(true);
    input('blinds-small', '15'); input('blinds-big', '50'); expect(confirm.disabled).toBe(false); click('blinds-confirm'); expect(onConfirm).toHaveBeenCalledWith({ smallBlind: 15, bigBlind: 50 });
  });
  it('accepts custom non-double stakes and maximum valid stakes', () => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); input('blinds-small', '999'); input('blinds-big', '1000'); expect(node('blinds-confirm').disabled).toBe(false);
    click('blinds-confirm'); expect(onConfirm).toHaveBeenCalledWith({ smallBlind: 999, bigBlind: 1000 });
  });
  it('cancels a changed draft, restores focus, and reopens from the caller value', () => {
    const origin = new Element('button'); doc.body.appendChild(origin); origin.focus(); panel.open({ smallBlind: 20, bigBlind: 40 }); click('blinds-preset-100-200'); click('blinds-cancel');
    expect(onConfirm).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce(); expect(doc.activeElement).toBe(origin); panel.close(); expect(onClose).toHaveBeenCalledOnce();
    panel.open({ smallBlind: 20, bigBlind: 40 }); expect(node('blinds-small').value).toBe('20'); expect(shield()).toBeUndefined();
  });
  it('handles Escape and traps both directions of keyboard focus inside the accessible dialog', () => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); const overlay = doc.body.children[0], dialog = overlay.children[0], prevent = vi.fn(), stop = vi.fn();
    expect(dialog.attributes.role).toBe('dialog'); expect(dialog.attributes['aria-modal']).toBe('true');
    overlay.onkeydown?.({ key: 'Tab', shiftKey: true, preventDefault: prevent, stopPropagation: stop }); expect(doc.activeElement).toBe(node('blinds-confirm'));
    overlay.onkeydown?.({ key: 'Tab', shiftKey: false, preventDefault: prevent, stopPropagation: stop }); expect(doc.activeElement).toBe(node('blinds-small'));
    overlay.onkeydown?.({ key: 'Escape', preventDefault: prevent, stopPropagation: stop }); expect(panel.isOpen).toBe(false); expect(onConfirm).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('blocks overlay propagation and absorbs a second tap for 300 ms after dismissing', () => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); const overlay = doc.body.children[0], stop = vi.fn(), prevent = vi.fn(); overlay.listeners.pointerdown[0]({ stopPropagation: stop }); expect(stop).toHaveBeenCalledOnce();
    click('blinds-cancel'); expect(shield()).toBeDefined(); shield()!.listeners.pointerdown[0]({ preventDefault: prevent, stopPropagation: stop }); expect(prevent).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(299); expect(shield()).toBeDefined(); vi.advanceTimersByTime(1); expect(shield()).toBeUndefined();
  });
  it('destroy removes draft and pending tap shield without notifying or committing', () => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); panel.destroy(); expect(onClose).not.toHaveBeenCalled(); expect(onConfirm).not.toHaveBeenCalled(); expect(doc.body.children).toHaveLength(0);
    panel.open({ smallBlind: 20, bigBlind: 40 }); panel.close(); expect(shield()).toBeDefined(); panel.destroy(); expect(shield()).toBeUndefined();
  });
  it('avoids duplicate dialogs and keeps landscape/keyboard layouts scrollable with safe areas', () => {
    panel.open({ smallBlind: 20, bigBlind: 40 }); panel.open({ smallBlind: 50, bigBlind: 100 }); expect(nodes(doc.body).filter(n => n.attributes.role === 'dialog')).toHaveLength(1); expect(node('blinds-small').value).toBe('20');
    const style = nodes(doc.head)[0].textContent; expect(style).toContain('100dvh'); expect(style).toContain('overflow-y:auto'); expect(style).toContain('safe-area-inset-bottom'); expect(style).toContain('font-size:18px'); expect(style).toContain('min-height:44px');
  });
});
