import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BettingContext, BettingPanel } from '../../assets/scripts/ui/BettingPanel';

class Element {
  children: Element[] = []; parent: Element | null = null; className = ''; dataset: Record<string, string> = {}; attributes: Record<string, string> = {}; style: Record<string, string> = {};
  disabled = false; value = ''; type = ''; tabIndex = 0; private text = '';
  onclick: ((event?: any) => void) | null = null; oninput: (() => void) | null = null; onblur: (() => void) | null = null; onkeydown: ((event: any) => void) | null = null;
  listeners: Record<string, ((event: any) => void)[]> = {}; captureListeners: Record<string, ((event: any) => void)[]> = {};
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get isConnected(): boolean { return this === doc.body || this === doc.head || Boolean(this.parent?.isConnected); }
  appendChild(child: Element): Element { child.parent = this; this.children.push(child); return child; }
  append(...children: Element[]): void { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children: Element[]): void { this.children.forEach(child => child.parent = null); this.children = []; this.text = ''; this.append(...children); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, listener: (event: any) => void, capture = false): void { ((capture ? this.captureListeners : this.listeners)[name] ??= []).push(listener); }
  focus(): void { doc.activeElement = this; }
  blur(): void { doc.activeElement = doc.body; this.onblur?.(); }
  contains(node: Element): boolean { return node === this || nodes(this).includes(node); }
  closest(selector: string): Element | null { return selector === 'button' && this.type === 'button' ? this : this.parent?.closest(selector) ?? null; }
}
class Input extends Element {}
let doc: { body: Element; head: Element; activeElement: Element; createElement(tag: string): Element; getElementById(id: string): Element | null };
function nodes(root: Element): Element[] { return root.children.flatMap(child => [child, ...nodes(child)]); }
function node(action: string): Element { const result = nodes(doc.body).find(n => n.dataset.action === action); expect(result, action).toBeDefined(); return result!; }
function click(action: string): void {
  const target = node(action); if (target.disabled) return;
  const path: Element[] = []; for (let current: Element | null = target; current; current = current.parent) path.push(current);
  let stopped = false; const event = { target, stopPropagation() { stopped = true; } };
  for (const current of path.slice().reverse()) { current.captureListeners.click?.forEach(listener => listener(event)); if (stopped) return; }
  target.onclick?.(event);
  for (const current of path) { current.listeners.click?.forEach(listener => listener(event)); if (stopped) return; }
}
let state: BettingContext; let panel: BettingPanel; let onConfirm: ReturnType<typeof vi.fn>; let onClose: ReturnType<typeof vi.fn>; let onInteract: ReturnType<typeof vi.fn>;
beforeEach(() => {
  doc = { body: new Element(), head: new Element(), activeElement: new Element(), createElement: tag => tag === 'input' ? new Input() : new Element(), getElementById: id => [...nodes(doc.body), ...nodes(doc.head)].find(node => node.attributes.id === id) ?? null };
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('HTMLInputElement', Input);
  state = { authorityKey: 's1:e1:h1:preflop:me', canAct: true, busy: false, bounds: { minTo: 120, maxTo: 505, pot: 200, toCall: 40, streetContribution: 40, step: 20 }, canAllIn: true, allInAmount: 465 };
  onConfirm = vi.fn(); onClose = vi.fn(); onInteract = vi.fn();
  panel = new BettingPanel({ getState: () => state, onConfirm, onClose, onInteract });
});
afterEach(() => { panel.destroy(); vi.unstubAllGlobals(); });

describe('betting drawer safety and native controls', () => {
  it.each(['raise', 'all-in'] as const)('shows the current countdown and safe timeout action in the %s dialog', mode => {
    state = { ...state, turnCountdown: { seconds: 17, urgent: false }, timeoutAction: 'fold' };
    if (mode === 'raise') panel.openRaise(); else panel.openAllIn();
    expect(doc.body.textContent).toContain('剩余 17 秒');
    expect(doc.body.textContent).toContain('超时自动弃牌');
    state = { ...state, turnCountdown: { seconds: 5, urgent: true }, timeoutAction: 'check' };
    panel.update();
    expect(doc.body.textContent).toContain('剩余 5 秒');
    expect(doc.body.textContent).toContain('超时自动过牌');
    expect(nodes(doc.body).find(n => n.className.includes('betting-countdown'))?.className).toContain('is-urgent');
  });
  it('updates countdown without resetting the raise draft, input focus or action authority', () => {
    state = { ...state, turnCountdown: { seconds: 12, urgent: false, fraction: .4 }, timeoutAction: 'fold' };
    panel.openRaise(); const input = node('betting-input'); input.value = '280'; input.oninput?.(); input.focus();
    state = { ...state, turnCountdown: { seconds: 11, urgent: false, fraction: .36 } };
    panel.update();
    expect(panel.isOpen).toBe(true); expect(doc.activeElement).toBe(input); expect(input.value).toBe('280');
    expect(doc.body.textContent).toContain('剩余 11 秒');
    click('betting-confirm'); expect(onConfirm).toHaveBeenCalledWith({ type: 'raise', to: 280 });
  });
  it('carries the live countdown into the second all-in confirmation instead of the opening value', () => {
    state = { ...state, turnCountdown: { seconds: 20, urgent: false }, timeoutAction: 'fold' };
    panel.openRaise(); click('betting-all-in');
    state = { ...state, turnCountdown: { seconds: 4, urgent: true } };
    click('betting-confirm');
    expect(doc.body.textContent).toContain('剩余 4 秒'); expect(doc.body.textContent).not.toContain('剩余 20 秒');
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it('does not invent a countdown when the host has no authoritative clock', () => {
    panel.openRaise(); expect(doc.body.textContent).not.toContain('剩余'); expect(doc.body.textContent).not.toContain('超时自动');
  });
  it.each(['raise', 'all-in'] as const)('rejects a late %s confirmation at deadline even before the host updates canAct', mode => {
    state = { ...state, turnCountdown: { seconds: 1, urgent: true }, timeoutAction: 'fold' };
    if (mode === 'raise') panel.openRaise(); else panel.openAllIn();
    state = { ...state, turnCountdown: { seconds: 0, urgent: true } };
    click(mode === 'raise' ? 'betting-confirm' : 'betting-confirm-all-in');
    expect(onConfirm).not.toHaveBeenCalled(); expect(panel.isOpen).toBe(false);
  });
  it('closes an expired dialog on update without placing an action', () => {
    state = { ...state, turnCountdown: { seconds: 1, urgent: true }, timeoutAction: 'check' }; panel.openRaise();
    state = { ...state, turnCountdown: { seconds: 0, urgent: true } }; panel.update();
    expect(panel.isOpen).toBe(false); expect(onConfirm).not.toHaveBeenCalled();
  });

  it('uses native number entry/range and presets without sending until explicit confirmation', () => {
    expect(panel.openRaise()).toBe(true); expect(node('betting-input').value).toBe('120');
    click('betting-half-pot'); expect(node('betting-input').value).toBe('180'); expect(node('betting-range').value).toBe('3'); expect(onConfirm).not.toHaveBeenCalled();
    node('betting-input').value = '319'; node('betting-input').oninput?.(); expect(node('betting-confirm').disabled).toBe(false);
    click('betting-confirm'); expect(onConfirm).toHaveBeenCalledTimes(1); expect(onConfirm).toHaveBeenCalledWith({ type: 'raise', to: 300 }); expect(panel.isOpen).toBe(false);
  });
  it('maps native slider steps to legal amounts including an unaligned all-in endpoint', () => {
    state.bounds = { ...state.bounds!, minTo: 110 }; panel.openRaise();
    node('betting-range').value = '1'; node('betting-range').oninput?.(); expect(node('betting-input').value).toBe('120');
    node('betting-range').value = '20'; node('betting-range').oninput?.(); expect(node('betting-input').value).toBe('500');
    node('betting-range').value = '21'; node('betting-range').oninput?.(); expect(node('betting-input').value).toBe('505');
    click('betting-confirm'); expect(onConfirm).not.toHaveBeenCalled(); expect(node('betting-confirm-all-in')).toBeDefined();
  });
  it('rejects empty/malformed amounts instead of silently placing a minimum or all-in bet', () => {
    panel.openRaise(); node('betting-input').value = ''; node('betting-input').oninput?.(); expect(node('betting-confirm').disabled).toBe(true);
    node('betting-input').value = '1e8'; node('betting-input').oninput?.(); expect(node('betting-confirm').disabled).toBe(true); expect(onConfirm).not.toHaveBeenCalled();
  });
  it('requires a separate all-in confirmation from both the direct button and a maximum raise', () => {
    panel.openAllIn(); expect(doc.body.textContent).toContain('465'); click('betting-cancel'); expect(onConfirm).not.toHaveBeenCalled();
    panel.openRaise(); click('betting-all-in'); expect(onConfirm).not.toHaveBeenCalled(); click('betting-confirm'); expect(onConfirm).not.toHaveBeenCalled();
    const confirm = node('betting-confirm-all-in'); click('betting-confirm-all-in'); confirm.onclick?.(); expect(onConfirm).toHaveBeenCalledTimes(1); expect(onConfirm).toHaveBeenCalledWith({ type: 'all-in' });
  });
  it.each(['authority', 'disconnected', 'busy', 'bounds', 'all-in'])('rejects an opened confirmation after %s changes even without update()', change => {
    panel.openAllIn(); const old = node('betting-confirm-all-in');
    if (change === 'authority') state = { ...state, authorityKey: 's1:e2:h1:preflop:me' };
    if (change === 'disconnected') state = { ...state, canAct: false };
    if (change === 'busy') state = { ...state, busy: true };
    if (change === 'bounds') state = { ...state, bounds: { ...state.bounds!, minTo: 140 } };
    if (change === 'all-in') state = { ...state, allInAmount: 400 };
    old.onclick?.(); expect(onConfirm).not.toHaveBeenCalled(); expect(panel.isOpen).toBe(false);
  });
  it('rechecks authority after onClose reentrancy before dispatching an action', () => {
    onClose.mockImplementation(() => { state = { ...state, busy: true }; });
    panel.openAllIn(); click('betting-confirm-all-in'); expect(onConfirm).not.toHaveBeenCalled(); expect(panel.isOpen).toBe(false);
  });
  it('closes on an authoritative update but leaves unchanged selection and focus alone', () => {
    panel.openRaise(); const input = node('betting-input'); input.focus(); input.value = '280'; input.oninput?.();
    panel.update(); expect(panel.isOpen).toBe(true); expect(doc.activeElement).toBe(input); expect(input.value).toBe('280');
    state = { ...state, canAct: false }; panel.update(); expect(panel.isOpen).toBe(false); expect(onConfirm).not.toHaveBeenCalled();
  });
  it('blocks opening without a legal action and restores focus on cancel while delegating one sound per click', () => {
    const origin = new Element(); doc.body.appendChild(origin); origin.focus(); panel.openRaise(); click('betting-pot'); expect(onInteract).toHaveBeenCalledOnce(); click('betting-cancel'); expect(onInteract).toHaveBeenCalledTimes(2); expect(doc.activeElement).toBe(origin);
    state = { ...state, canAct: false }; expect(panel.openRaise()).toBe(false); expect(panel.openAllIn()).toBe(false);
  });
  it('stops overlay pointer propagation, supplies a modal label and uses safe text nodes', () => {
    panel.openRaise(); const overlay = doc.body.children[0]; const stop = vi.fn(); overlay.listeners.pointerdown[0]({ stopPropagation: stop }); expect(stop).toHaveBeenCalledOnce();
    expect(overlay.children[0].attributes['aria-modal']).toBe('true'); expect(overlay.children[0].attributes['aria-label']).toBe('加注至');
    expect(nodes(doc.head)[0].textContent).toContain('min-height:44px');
  });
});
