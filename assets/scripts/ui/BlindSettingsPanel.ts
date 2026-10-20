import { validateBlinds } from '../core/Blinds';
import type { BlindConfig } from '../core/Blinds';

export interface BlindSettingsPanelActions {
  onConfirm(config: BlindConfig): void;
  onClose?(): void;
}

/** Edits a local draft; only explicit valid confirmation commits it. */
export class BlindSettingsPanel {
  private overlay: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private small: HTMLInputElement | null = null;
  private big: HTMLInputElement | null = null;
  private error: HTMLParagraphElement | null = null;
  private confirm: HTMLButtonElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private shield: HTMLDivElement | null = null;
  private shieldTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly actions: BlindSettingsPanelActions) {}
  public get isOpen(): boolean { return this.overlay !== null; }

  public open(initial: BlindConfig): void {
    if (this.isOpen) return;
    this.removeShield(); installStyle();
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    const overlay = element('div', 'poker-blinds-overlay');
    const panel = element('div', 'poker-blinds-panel');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'poker-blinds-title'); panel.setAttribute('aria-describedby', 'poker-blinds-description'); panel.tabIndex = -1;
    const title = element('h2'); title.setAttribute('id', 'poker-blinds-title'); title.textContent = '盲注设置';
    const hint = element('p', 'poker-blinds-hint'); hint.setAttribute('id', 'poker-blinds-description'); hint.textContent = '开局后固定 · 初始 5,000 筹码'; panel.append(title, hint);
    const fields = element('div', 'poker-blinds-fields');
    this.small = this.field(fields, '小盲', 'blinds-small', initial.smallBlind);
    this.big = this.field(fields, '大盲', 'blinds-big', initial.bigBlind); panel.appendChild(fields);
    const presets = element('div', 'poker-blinds-presets');
    for (const [smallBlind, bigBlind] of [[10, 20], [20, 40], [50, 100], [100, 200]]) {
      this.button(presets, `${smallBlind} / ${bigBlind}`, `blinds-preset-${smallBlind}-${bigBlind}`, () => {
        this.small!.value = String(smallBlind); this.big!.value = String(bigBlind); this.validate();
      });
    }
    panel.appendChild(presets);
    this.error = element('p', 'poker-blinds-error'); this.error.setAttribute('id', 'poker-blinds-error'); this.error.setAttribute('aria-live', 'polite'); panel.appendChild(this.error);
    const note = element('p', 'poker-blinds-note'); note.textContent = '联机仅创建房间时生效；加入房间沿用房主设置。'; panel.appendChild(note);
    const footer = element('div', 'poker-blinds-actions'); this.button(footer, '取消', 'blinds-cancel', () => this.close());
    this.confirm = this.button(footer, '保存设置', 'blinds-confirm', () => this.submit(), 'poker-blinds-primary'); panel.appendChild(footer);
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel']) overlay.addEventListener(type, event => event.stopPropagation());
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first?.focus(); }
    };
    overlay.appendChild(panel); this.overlay = overlay; this.panel = panel; document.body.appendChild(overlay); this.validate(); panel.focus({ preventScroll: true });
  }

  public close(): void { this.dismiss(true); }
  public destroy(): void { this.dismiss(false, false); this.removeShield(); }

  private dismiss(notify: boolean, blockPointer = true): boolean {
    if (!this.overlay) return false;
    this.overlay.remove(); this.overlay = null; this.panel = null; this.small = null; this.big = null; this.error = null; this.confirm = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true }); this.previousFocus = null;
    if (blockPointer) this.addShield();
    if (notify) this.actions.onClose?.();
    return true;
  }
  private value(): BlindConfig | null {
    const smallBlind = parseAmount(this.small?.value ?? ''), bigBlind = parseAmount(this.big?.value ?? '');
    const value = { smallBlind, bigBlind }; return validateBlinds(value) ? { ...value } : null;
  }
  private validate(): void {
    const valid = this.value() !== null;
    this.small?.setAttribute('aria-invalid', String(!valid)); this.big?.setAttribute('aria-invalid', String(!valid));
    if (this.confirm) this.confirm.disabled = !valid;
    if (this.error) this.error.textContent = valid ? '' : '请输入正整数，且小盲 < 大盲 ≤ 1,000。';
  }
  private submit(): void {
    if (!this.isOpen) return;
    const value = this.value(); if (!value) { this.validate(); return; }
    // Remove the draft before notifying; stale and repeated clicks cannot save again.
    this.dismiss(false); this.actions.onConfirm(value); this.actions.onClose?.();
  }
  private field(parent: HTMLElement, title: string, action: string, value: number): HTMLInputElement {
    const label = element('label', 'poker-blinds-field'); const text = element('span'); text.textContent = title;
    const input = element('input'); input.type = 'text'; input.inputMode = 'numeric'; input.pattern = '[0-9]*'; input.maxLength = 10; input.autocomplete = 'off'; input.value = String(value); input.dataset.action = action;
    input.setAttribute('aria-label', title); input.setAttribute('aria-describedby', 'poker-blinds-error'); input.oninput = () => this.validate();
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); this.submit(); } };
    label.append(text, input); parent.appendChild(label); return input;
  }
  private button(parent: HTMLElement, title: string, action: string, callback: () => void, className = ''): HTMLButtonElement {
    const button = element('button', className); button.type = 'button'; button.textContent = title; button.dataset.action = action;
    button.onclick = () => { if (!button.disabled && button.isConnected && this.overlay?.contains(button)) callback(); }; parent.appendChild(button); return button;
  }
  private addShield(): void {
    this.removeShield(); const shield = element('div', 'poker-blinds-shield'); shield.setAttribute('aria-hidden', 'true');
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click']) shield.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
    document.body.appendChild(shield); this.shield = shield; this.shieldTimer = setTimeout(() => this.removeShield(), 300);
  }
  private removeShield(): void { if (this.shieldTimer !== null) clearTimeout(this.shieldTimer); this.shieldTimer = null; this.shield?.remove(); this.shield = null; }
}

function parseAmount(raw: string): number | null { const value = raw.trim(); return /^\d{1,10}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] { const result = document.createElement(tag); result.className = className; return result; }
function installStyle(): void {
  if (document.getElementById('poker-blinds-style')) return;
  const style = element('style'); style.setAttribute('id', 'poker-blinds-style'); style.textContent = `
.poker-blinds-overlay,.poker-blinds-shield{position:fixed;inset:0;z-index:10030;box-sizing:border-box}.poker-blinds-shield{background:transparent;touch-action:none}.poker-blinds-overlay{display:grid;place-items:center;background:#070e12cc;padding:max(12px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));touch-action:pan-y}
.poker-blinds-panel{box-sizing:border-box;width:min(520px,100%);max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow-y:auto;overscroll-behavior:contain;padding:24px;border:1px solid #34474A;border-radius:16px;background:#18272B;color:#F2EFE7;font:16px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 16px 64px #0008;outline:none}.poker-blinds-panel h2{margin:0;font-size:22px;font-weight:600}.poker-blinds-hint{color:#D6B575;font-size:14px;margin:4px 0 18px}.poker-blinds-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}.poker-blinds-field{display:flex;flex-direction:column;gap:6px}.poker-blinds-panel input{box-sizing:border-box;width:100%;min-width:0;min-height:48px;padding:10px 12px;background:#10191D;color:#F2EFE7;border:1px solid #34474A;border-radius:8px;font:inherit;font-size:18px;user-select:text;font-variant-numeric:tabular-nums}.poker-blinds-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}.poker-blinds-panel button{box-sizing:border-box;min-height:44px;padding:8px;border:1px solid #34474A;border-radius:8px;background:#22363A;color:#F2EFE7;font:inherit;cursor:pointer;touch-action:manipulation}.poker-blinds-panel button:disabled{opacity:.45;cursor:default}.poker-blinds-panel :focus-visible{outline:2px solid #D6B575;outline-offset:2px}.poker-blinds-error{min-height:21px;margin:8px 0 0;font-size:13px;color:#F4AC9C}.poker-blinds-note{margin:4px 0 14px;font-size:13px;color:#9BAEAC}.poker-blinds-actions{display:grid;grid-template-columns:1fr 1.5fr;gap:12px}.poker-blinds-panel .poker-blinds-primary{background:#26745A;border-color:#26745A}
@media(max-width:960px) and (orientation:landscape){.poker-blinds-panel{padding:14px 20px}.poker-blinds-panel h2{font-size:20px}.poker-blinds-hint{margin-bottom:10px}.poker-blinds-presets{margin-top:10px}.poker-blinds-note{margin-bottom:10px}}
@media(max-width:400px){.poker-blinds-presets{grid-template-columns:repeat(2,1fr)}}
@media(max-height:330px){.poker-blinds-overlay{padding-top:0;padding-bottom:0}.poker-blinds-panel{max-height:100dvh;border-radius:8px}}
`; document.head.appendChild(style);
}
