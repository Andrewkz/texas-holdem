import type { PlayerAction } from '../core/types';
import { chooseRaisePreset, normalizeRaiseTo } from './RaiseAmount';
import type { RaiseBounds, RaisePreset } from './RaiseAmount';

export interface BettingContext {
  /** Must identify mode, session, table epoch, hand, street and current actor. */
  authorityKey: string;
  canAct: boolean;
  busy: boolean;
  bounds: RaiseBounds | null;
  canAllIn: boolean;
  /** Remaining chips committed by an all-in, excluding this street's existing contribution. */
  allInAmount: number;
  /** Read from the existing authoritative turn clock; opening a dialog never starts a new clock. */
  turnCountdown?: { seconds: number; urgent: boolean; fraction?: number } | null;
  timeoutAction?: 'check' | 'fold';
}
export interface BettingPanelActions {
  getState(): BettingContext;
  onConfirm(action: PlayerAction): void;
  onClose(): void;
  onInteract?(): void;
}

/** Presentation only; confirmation re-reads authority and never queues a future action. */
export class BettingPanel {
  private overlay: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private input: HTMLInputElement | null = null;
  private slider: HTMLInputElement | null = null;
  private amount: HTMLElement | null = null;
  private details: HTMLElement | null = null;
  private confirm: HTMLButtonElement | null = null;
  private countdown: HTMLElement | null = null;
  private countdownKey = '';
  private previousFocus: HTMLElement | null = null;
  private openedKey = '';
  private openedState: BettingContext | null = null;
  private mode: 'raise' | 'all-in' | null = null;
  private submitted = false;
  private inputShield: HTMLDivElement | null = null;
  private shieldTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly actions: BettingPanelActions) {}
  public get isOpen(): boolean { return this.overlay !== null; }

  public openRaise(): boolean {
    const state = this.actions.getState();
    if (!eligible(state) || !validBounds(state.bounds)) return false;
    this.begin(state); this.renderRaise(state.bounds!); return true;
  }
  public openAllIn(): boolean {
    const state = this.actions.getState();
    if (!eligible(state) || !state.canAllIn || !validAmount(state.allInAmount)) return false;
    this.begin(state); this.renderAllIn(); return true;
  }
  public update(): void {
    if (!this.isOpen) return;
    const state = this.current();
    if (!state) { this.close(); return; }
    this.updateCountdown(state);
  }
  public close(notify = true): void {
    if (!this.isOpen) return;
    this.overlay?.remove(); this.overlay = null; this.panel = null; this.input = null; this.slider = null; this.amount = null; this.details = null; this.confirm = null; this.mode = null; this.countdown = null; this.countdownKey = '';
    this.openedState = null; this.openedKey = '';
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = null;
    if (notify) this.actions.onClose();
  }
  public destroy(): void { this.close(false); this.removeShield(); }

  private begin(state: BettingContext): void {
    if (this.isOpen) this.close(false);
    this.removeShield();
    ensureStyle();
    this.openedState = { ...state, bounds: state.bounds ? { ...state.bounds } : null };
    this.openedKey = contextKey(state); this.submitted = false;
    const active = document.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    if (active instanceof HTMLInputElement) active.blur();
    const overlay = this.element('div', 'poker-betting-overlay');
    ['pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(type => overlay.addEventListener(type, event => event.stopPropagation()));
    overlay.addEventListener('click', event => {

      const target = event.target instanceof HTMLElement ? event.target.closest('button') : null;
      if (target && !(target as HTMLButtonElement).disabled) this.actions.onInteract?.();
    }, true);
    overlay.addEventListener('click', event => event.stopPropagation());
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      if (event.key === 'Tab') {
        const controls = this.panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === this.panel)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    this.overlay = overlay; document.body.appendChild(overlay);
  }
  private createPanel(title: string): HTMLDivElement {
    const panel = this.element('div', 'poker-betting-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title); panel.tabIndex = -1;
    this.overlay!.replaceChildren(panel); this.panel = panel;
    this.countdown = this.element('div', 'betting-countdown'); this.countdown.setAttribute('role', 'timer'); this.countdown.setAttribute('aria-live', 'off');
    panel.appendChild(this.countdown); this.countdownKey = ''; this.updateCountdown(this.actions.getState());
    panel.focus({ preventScroll: true }); return panel;
  }
  private updateCountdown(state: BettingContext): void {
    if (!this.countdown) return;
    const clock = state.turnCountdown;
    const visible = Boolean(clock && Number.isFinite(clock.seconds));
    const seconds = visible ? Math.max(0, Math.ceil(clock!.seconds)) : 0;
    const urgent = visible && (clock!.urgent || seconds <= 5);
    const action = state.timeoutAction === 'check' ? '过牌' : state.timeoutAction === 'fold' ? '弃牌' : '';
    const key = `${visible}:${seconds}:${urgent}:${action}`;
    if (key === this.countdownKey) return;
    this.countdownKey = key;
    this.countdown.className = `betting-countdown${visible ? '' : ' is-hidden'}${urgent ? ' is-urgent' : ''}`;
    this.countdown.textContent = visible ? `剩余 ${seconds} 秒${action ? ` · 超时自动${action}` : ''}` : '';
  }
  private renderRaise(bounds: RaiseBounds): void {
    this.mode = 'raise';
    const panel = this.createPanel('加注至');
    const heading = this.element('div', 'betting-heading');
    const title = this.element('h2'); title.textContent = '加注至';
    const hint = this.element('p', 'betting-hint'); hint.textContent = `总底池 ${chips(bounds.pot)} · 需跟注 ${chips(bounds.toCall)}`; heading.append(title, hint); panel.appendChild(heading);
    const entry = this.element('div', 'betting-entry'); this.amount = this.element('strong', 'betting-amount');
    const input = this.element('input', 'betting-input'); input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]*'; input.maxLength = 10; input.autocomplete = 'off'; input.setAttribute('aria-label', '本轮总下注额，含已投入筹码'); input.dataset.action = 'betting-input';
    input.oninput = () => this.updateAmount(false); input.onblur = () => this.updateAmount(true);
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } };
    this.input = input; entry.append(this.amount, input); panel.appendChild(entry);
    const slider = this.element('input', 'betting-slider'); slider.type = 'range'; slider.min = '0'; slider.max = String(sliderLastIndex(bounds)); slider.step = '1'; slider.setAttribute('aria-label', '调整本轮总下注额'); slider.dataset.action = 'betting-range';
    slider.oninput = () => { if (this.input) this.input.value = String(sliderAmount(Number(slider.value), bounds)); this.updateAmount(true); }; this.slider = slider; panel.appendChild(slider);
    const presets = this.element('div', 'betting-presets');
    const labels: [RaisePreset, string][] = [['minimum', '最小'], ['half-pot', '半池'], ['pot', '满池'], ['all-in', '全压']];
    labels.forEach(([preset, label]) => this.button(presets, label, `betting-${preset}`, () => {
      if (!this.current() || !this.input) { this.close(); return; }
      this.input.value = String(chooseRaisePreset(preset, bounds)); this.updateAmount(true);
    })); panel.appendChild(presets);
    this.details = this.element('p', 'betting-details'); this.details.setAttribute('aria-live', 'polite'); panel.appendChild(this.details);
    const footer = this.element('div', 'betting-actions');
    this.button(footer, '取消', 'betting-cancel', () => this.close());
    this.confirm = this.button(footer, '确认加注', 'betting-confirm', () => this.confirmRaise(), 'betting-primary'); panel.appendChild(footer);
    input.value = String(bounds.minTo); this.updateAmount(true);
  }
  private updateAmount(normalize: boolean): void {
    if (!this.input || !this.slider || !this.openedState?.bounds) return;
    const bounds = this.openedState.bounds;
    const raw = parseAmount(this.input.value);
    if (raw === null) {
      if (this.confirm) this.confirm.disabled = true;
      if (this.details) this.details.textContent = '请输入完整的筹码数字。';
      return;
    }
    const selected = normalizeRaiseTo(raw, bounds);
    if (normalize) this.input.value = String(selected);
    this.slider.value = String(sliderIndex(selected, bounds));
    this.slider.setAttribute('aria-valuetext', `${chips(selected)} 筹码`);
    if (this.amount) this.amount.textContent = chips(selected);
    if (this.details) this.details.textContent = `本轮总额 ${chips(selected)} · 本次投入 ${chips(selected - bounds.streetContribution)} · 可选 ${chips(bounds.minTo)}–${chips(bounds.maxTo)}`;
    if (this.confirm) { this.confirm.disabled = false; this.confirm.textContent = selected === bounds.maxTo ? '继续确认全压' : `确认加注至 ${chips(selected)}`; }
  }
  private confirmRaise(): void {
    const state = this.current();
    if (!state || this.mode !== 'raise' || !validBounds(state.bounds)) { this.close(); return; }
    const raw = parseAmount(this.input?.value ?? '');
    if (raw === null) return;
    const to = normalizeRaiseTo(raw, state.bounds!);
    if (to === state.bounds!.maxTo) {
      if (!state.canAllIn || !validAmount(state.allInAmount)) { this.close(); return; }
      this.renderAllIn(); return;
    }
    this.submit({ type: 'raise', to });
  }
  private renderAllIn(): void {
    this.mode = 'all-in'; this.input = null; this.slider = null; this.confirm = null;
    const panel = this.createPanel('确认全压');
    const title = this.element('h2'); title.textContent = '确认全压？'; panel.appendChild(title);
    const text = this.element('p', 'betting-all-in-copy'); text.textContent = `将投入剩余全部 ${chips(this.openedState!.allInAmount)} 筹码。`; panel.appendChild(text);
    const hint = this.element('p', 'betting-hint'); hint.textContent = '确认后立即行动，无法撤回。'; panel.appendChild(hint);
    const footer = this.element('div', 'betting-actions'); this.button(footer, '取消', 'betting-cancel', () => this.close());
    this.button(footer, '确认全压', 'betting-confirm-all-in', () => {
      const state = this.current();
      if (!state || this.mode !== 'all-in' || !state.canAllIn || !validAmount(state.allInAmount)) { this.close(); return; }
      this.submit({ type: 'all-in' });
    }, 'betting-danger'); panel.appendChild(footer);
  }
  private current(): BettingContext | null {
    const state = this.actions.getState();
    return this.isOpen && !this.submitted && eligible(state) && contextKey(state) === this.openedKey ? state : null;
  }
  private submit(action: PlayerAction): void {
    if (!this.current()) { this.close(); return; }
    const confirmedKey = this.openedKey;
    this.submitted = true; this.close();
    const latest = this.actions.getState();
    if (!eligible(latest) || contextKey(latest) !== confirmedKey || this.isOpen) return;
    // Absorb the remainder of a double tap after dismissing the confirmation.
    const shield = this.element('div', 'poker-betting-input-shield'); shield.setAttribute('aria-hidden', 'true');
    shield.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    shield.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
    document.body.appendChild(shield); this.inputShield = shield;
    this.shieldTimer = setTimeout(() => this.removeShield(), 300);
    this.actions.onConfirm(action);
  }
  private removeShield(): void { if (this.shieldTimer !== null) clearTimeout(this.shieldTimer); this.shieldTimer = null; this.inputShield?.remove(); this.inputShield = null; }
  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] { const element = document.createElement(tag); element.className = className; return element; }
  private button(parent: HTMLElement, text: string, action: string, callback: () => void, className = ''): HTMLButtonElement {
    const button = this.element('button', className); button.type = 'button'; button.textContent = text; button.dataset.action = action; button.onclick = () => { if (!button.disabled && button.isConnected && this.overlay?.contains(button)) callback(); }; parent.appendChild(button); return button;
  }
}

function sliderLastIndex(bounds: RaiseBounds): number { const first = (Math.floor(bounds.minTo / bounds.step) + 1) * bounds.step; return bounds.minTo === bounds.maxTo ? 0 : Math.max(0, Math.ceil((bounds.maxTo - first) / bounds.step)) + 1; }
function sliderAmount(index: number, bounds: RaiseBounds): number { if (index <= 0) return bounds.minTo; if (index >= sliderLastIndex(bounds)) return bounds.maxTo; return (Math.floor(bounds.minTo / bounds.step) + index) * bounds.step; }
function sliderIndex(amount: number, bounds: RaiseBounds): number { if (amount <= bounds.minTo) return 0; if (amount >= bounds.maxTo) return sliderLastIndex(bounds); return Math.floor(amount / bounds.step) - Math.floor(bounds.minTo / bounds.step); }
function parseAmount(value: string): number | null { const text = value.trim(); if (!/^\d{1,10}$/.test(text)) return null; const amount = Number(text); return Number.isSafeInteger(amount) ? amount : null; }
function validAmount(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function validBounds(bounds: RaiseBounds | null): boolean {
  return Boolean(bounds && validAmount(bounds.minTo) && validAmount(bounds.maxTo) && bounds.minTo <= bounds.maxTo && validAmount(bounds.step)
    && Number.isSafeInteger(bounds.streetContribution) && bounds.streetContribution >= 0 && bounds.streetContribution < bounds.minTo
    && Number.isSafeInteger(bounds.pot) && bounds.pot >= 0 && Number.isSafeInteger(bounds.toCall) && bounds.toCall >= 0);
}
function eligible(state: BettingContext): boolean { return Boolean(state.authorityKey && state.canAct && !state.busy && (!state.turnCountdown || (Number.isFinite(state.turnCountdown.seconds) && state.turnCountdown.seconds > 0))); }
function contextKey(state: BettingContext): string { const b = state.bounds; return JSON.stringify([state.authorityKey, state.canAct, state.busy, state.canAllIn, state.allInAmount, b ? [b.minTo, b.maxTo, b.pot, b.toCall, b.streetContribution, b.step] : null]); }
function chips(value: number): string { return value.toLocaleString('zh-CN'); }

function ensureStyle(): void {
  if (document.getElementById('poker-betting-style')) return;
  const style = document.createElement('style'); style.setAttribute('id', 'poker-betting-style');
  style.textContent = `
.poker-betting-input-shield{position:fixed;inset:0;z-index:1900;background:transparent;touch-action:none}
.poker-betting-overlay{position:fixed;inset:0;z-index:1900;display:grid;place-items:center;background:#070e12bb;padding:max(12px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));box-sizing:border-box;touch-action:pan-y}
.poker-betting-panel{width:min(760px,100%);max-height:calc(100svh - 24px);overflow:auto;box-sizing:border-box;border:1px solid #34474A;border-radius:16px;background:#18272B;color:#F2EFE7;padding:20px 24px;font:16px/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 16px 64px #0008;outline:none}
.betting-countdown{position:sticky;top:0;z-index:1;background:#18272B;padding:0 0 8px;color:#D6B575;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}.betting-countdown.is-urgent{color:#FFB0A0}.betting-countdown.is-hidden{display:none}\n.poker-betting-panel h2,.poker-betting-panel p{margin:0}.poker-betting-panel h2{font-size:21px;font-weight:600}.betting-heading,.betting-entry{display:flex;align-items:center;justify-content:space-between;gap:16px}.betting-hint,.betting-details{color:#9BAEAC;font-size:13px}.betting-entry{margin-top:12px}.betting-amount{color:#D6B575;font-size:30px;font-variant-numeric:tabular-nums}.betting-input{box-sizing:border-box;width:150px;min-height:44px;padding:8px 12px;border:1px solid #34474A;border-radius:8px;background:#10191D;color:#F2EFE7;font:inherit;font-size:16px;user-select:text}.betting-slider{display:block;box-sizing:border-box;width:100%;min-height:44px;margin:4px 0;accent-color:#D6B575;touch-action:pan-x;cursor:pointer}.betting-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.poker-betting-panel button{box-sizing:border-box;min-height:44px;padding:8px 14px;border:1px solid #34474A;border-radius:8px;background:#22363A;color:#F2EFE7;font:inherit;cursor:pointer;touch-action:manipulation}.poker-betting-panel button:disabled{opacity:.45;cursor:default}.poker-betting-panel button:focus-visible,.betting-input:focus-visible,.betting-slider:focus-visible{outline:2px solid #D6B575;outline-offset:2px}.poker-betting-panel .betting-primary{background:#26745A;border-color:#26745A}.poker-betting-panel .betting-danger{background:#9E773E;border-color:#D6B575}.betting-details{margin-top:8px!important;min-height:19px}.betting-actions{display:grid;grid-template-columns:1fr 1.5fr;gap:12px;margin-top:12px}.betting-all-in-copy{font-size:21px;color:#D6B575;margin:20px 0 12px!important}
@media(max-width:960px) and (orientation:landscape){.poker-betting-overlay{align-items:end;padding:0}.poker-betting-panel{width:100%;max-width:none;max-height:100svh;min-height:min(285px,100svh);border-radius:16px 16px 0 0;padding:12px max(20px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))}.betting-entry{margin-top:8px}.betting-details{margin-top:4px!important}.betting-actions{margin-top:8px}.betting-heading h2{font-size:18px}.betting-amount{font-size:28px}}
@media(max-height:330px){.poker-betting-panel{max-height:100svh;min-height:0}.betting-heading{align-items:baseline}.betting-entry{margin-top:4px}}
@media(prefers-reduced-motion:reduce){.poker-betting-panel{scroll-behavior:auto}}
`;
  document.head.appendChild(style);
}
