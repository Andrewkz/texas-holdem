import type { HandResult } from './HandResultModel';

export interface HandResultPanelActions {
  onSkip?(): void;
  onClose(): void;
  onInteract?(): void;
}

/** Read-only hand summary. The host owns progression and the settlement deadline. */
export class HandResultPanel {
  private overlay: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private countdown: HTMLParagraphElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private inputShield: HTMLDivElement | null = null;
  private shieldTimer: ReturnType<typeof setTimeout> | null = null;
  private canSkip = false;

  public constructor(private readonly actions: HandResultPanelActions) {}
  public get isOpen(): boolean { return this.overlay !== null; }

  public show(result: HandResult, options: { canSkip: boolean; seconds?: number }): void {
    this.close(); this.removeShield(); ensureStyle(); this.canSkip = options.canSkip;
    const active = document.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    const overlay = this.element('div', 'poker-hand-result-overlay');
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(type => overlay.addEventListener(type, event => event.stopPropagation()));
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.dismiss(false); return; }
      if (event.key !== 'Tab') return;
      const buttons = this.panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === this.panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === this.panel)) { event.preventDefault(); first.focus(); }
    };
    const panel = this.element('div', 'poker-hand-result-panel');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'poker-hand-result-heading'); panel.tabIndex = -1;
    const header = this.element('header', 'hand-result-heading');
    const title = this.element('h2'); title.setAttribute('id', 'poker-hand-result-heading'); title.textContent = `第 ${chips(result.handId)} 手结算`;
    const subtitle = this.element('p', 'hand-result-hint'); subtitle.textContent = '获得筹码含本手投入，不等同于净盈亏'; header.append(title, subtitle); panel.appendChild(header);
    const list = this.element('div', 'hand-result-winners'); list.setAttribute('aria-label', '本手筹码分配');
    for (const winner of result.winners) {
      const row = this.element('article', 'hand-result-winner');
      const name = this.element('h3', 'hand-result-name'); name.textContent = `${winner.name}${winner.isSelf ? ' · 你' : ''}`;
      const amount = this.element('strong', 'hand-result-amount'); amount.textContent = `获得 ${chips(winner.amount)}`;
      const hand = this.element('p', 'hand-result-hand'); hand.textContent = winner.handNames.join(' / ') || '本手分配';
      row.append(name, amount, hand); list.appendChild(row);
    }
    if (!result.winners.length) { const empty = this.element('p', 'hand-result-hint'); empty.textContent = '本手暂无可显示的筹码分配。'; list.appendChild(empty); }
    panel.appendChild(list);
    const totals = this.element('div', 'hand-result-totals');
    const total = this.element('p'); total.textContent = `分配合计 ${chips(result.totalAwarded)}`; totals.appendChild(total);
    if (result.selfNet !== undefined) {
      const net = this.element('p', 'hand-result-net'); net.textContent = `你的本手净变化 ${signed(result.selfNet)}`;
      net.setAttribute('data-net', result.selfNet > 0 ? 'positive' : result.selfNet < 0 ? 'negative' : 'zero'); totals.appendChild(net);
    }
    panel.appendChild(totals);
    const footer = this.element('footer', 'hand-result-footer');
    this.countdown = this.element('p', 'hand-result-countdown'); this.countdown.setAttribute('aria-live', 'off'); footer.appendChild(this.countdown);
    const controls = this.element('div', 'hand-result-actions');
    this.button(controls, options.canSkip ? '收起结果' : '关闭', 'hand-result-close', () => this.dismiss(false));
    if (options.canSkip) this.button(controls, '下一手', 'hand-result-skip', () => this.dismiss(true), 'hand-result-primary');
    footer.appendChild(controls); panel.appendChild(footer);
    this.panel = panel; this.overlay = overlay; overlay.appendChild(panel); document.body.appendChild(overlay);
    this.updateSeconds(options.seconds ?? Number.NaN); panel.focus({ preventScroll: true });
  }

  public updateSeconds(seconds: number): void {
    if (!this.countdown) return;
    const text = this.canSkip && Number.isFinite(seconds) ? `${Math.max(0, Math.ceil(seconds))} 秒后自动开始下一手` : '';
    if (this.countdown.textContent !== text) this.countdown.textContent = text;
  }

  /** Lifecycle close is silent, so authoritative updates cannot start a second hand. */
  public close(): void {
    this.overlay?.remove(); this.overlay = null; this.panel = null; this.countdown = null; this.canSkip = false;
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = null;
  }
  public destroy(): void { this.close(); this.removeShield(); }

  private dismiss(skip: boolean): void {
    if (!this.isOpen || (skip && !this.canSkip)) return;
    this.actions.onInteract?.(); this.close(); this.addShield();
    if (skip) this.actions.onSkip?.(); else this.actions.onClose();
  }
  private addShield(): void {
    this.removeShield(); const shield = this.element('div', 'poker-hand-result-input-shield'); shield.setAttribute('aria-hidden', 'true');
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach(type => shield.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); }));
    document.body.appendChild(shield); this.inputShield = shield;
    this.shieldTimer = setTimeout(() => this.removeShield(), 300);
  }
  private removeShield(): void { if (this.shieldTimer !== null) clearTimeout(this.shieldTimer); this.shieldTimer = null; this.inputShield?.remove(); this.inputShield = null; }
  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] { const node = document.createElement(tag); node.className = className; return node; }
  private button(parent: HTMLElement, label: string, action: string, callback: () => void, className = ''): void {
    const button = this.element('button', className); button.type = 'button'; button.textContent = label; button.dataset.action = action;
    button.onclick = () => { if (button.isConnected && this.overlay?.contains(button)) callback(); }; parent.appendChild(button);
  }
}

function chips(value: number): string { return value.toLocaleString('zh-CN'); }
function signed(value: number): string { return value > 0 ? `+${chips(value)}` : chips(value); }
function ensureStyle(): void {
  if (document.getElementById('poker-hand-result-style')) return;
  const style = document.createElement('style'); style.setAttribute('id', 'poker-hand-result-style');
  style.textContent = `
.poker-hand-result-overlay{position:fixed;inset:0;z-index:1850;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));box-sizing:border-box;background:#071014ad;touch-action:pan-y}
.poker-hand-result-input-shield{position:fixed;inset:0;z-index:1850;touch-action:none;background:transparent}
.poker-hand-result-panel{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;width:min(680px,100%);max-height:calc(100svh - 24px);padding:22px 24px;border:1px solid #4c5548;border-radius:16px;background:#17272b;color:#f2efe7;box-shadow:0 18px 60px #0009;font:15px/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;outline:none}
.poker-hand-result-panel h2,.poker-hand-result-panel h3,.poker-hand-result-panel p{margin:0}.poker-hand-result-panel h2{font-size:22px;font-weight:600}.hand-result-hint{margin-top:4px!important;color:#a8b9b6;font-size:13px}.hand-result-winners{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-height:0;overflow:auto;overscroll-behavior:contain}.hand-result-winner{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;padding:12px;border:1px solid #34494b;border-radius:10px;background:#1c3034}.hand-result-name{font-size:14px;font-weight:500;overflow-wrap:anywhere}.hand-result-amount{font-size:14px;white-space:nowrap;font-variant-numeric:tabular-nums;color:#e4c17d}.hand-result-hand{grid-column:1/-1;color:#a8b9b6;font-size:12px}.hand-result-totals{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 16px;color:#c4ceca;font-size:14px;font-variant-numeric:tabular-nums}.hand-result-net[data-net=positive]{color:#81d7ae}.hand-result-net[data-net=negative]{color:#eea598}.hand-result-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.hand-result-countdown{color:#c4ceca;font-size:13px;font-variant-numeric:tabular-nums}.hand-result-actions{display:flex;gap:10px;margin-left:auto}.poker-hand-result-panel button{min-height:44px;min-width:88px;padding:8px 16px;border:1px solid #3e5557;border-radius:8px;background:#22383c;color:#f2efe7;font:inherit;cursor:pointer;touch-action:manipulation}.poker-hand-result-panel button:focus-visible{outline:2px solid #dfbe7a;outline-offset:2px}.poker-hand-result-panel .hand-result-primary{background:#26745a;border-color:#39866b}
@media(max-height:450px){.poker-hand-result-panel{gap:10px;padding:12px 16px}.poker-hand-result-panel h2{font-size:18px}.hand-result-winner{padding:8px 10px}.hand-result-hint{font-size:12px}}
@media(max-width:520px){.hand-result-winners{grid-template-columns:1fr}.hand-result-footer{flex-wrap:wrap}.hand-result-actions{width:100%}.hand-result-actions button{flex:1}.hand-result-countdown{width:100%}.poker-hand-result-panel{padding:16px}}
`;
  document.head.appendChild(style);
}
