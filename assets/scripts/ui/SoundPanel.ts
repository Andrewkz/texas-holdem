import { normalizeBlinds } from '../core/Blinds';
import { AnimationSpeed, GameSettings } from './GameSettings';

export interface SoundPanelActions {
  getSettings(): GameSettings;
  onChange(patch: Partial<GameSettings>): void;
  onClose(): void;
  onBlinds?(): void;
  canConfigureBlinds?(): boolean;
}

const STYLE_ID = 'poker-sound-panel-style';
const STYLE = `
.poker-sound-overlay{position:fixed;inset:0;z-index:10020;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(5,12,14,.76);font-family:system-ui,-apple-system,sans-serif;color:#F2EFE7}
.poker-sound-panel{box-sizing:border-box;width:100%;max-width:464px;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;padding:24px;background:#18272B;border:1px solid #34474A;border-radius:16px;box-shadow:0 18px 80px #0007}
.poker-sound-panel h2{font-size:22px;margin:0 0 6px;font-weight:600}.poker-sound-hint{font-size:13px;line-height:1.5;color:#9BAEAC;margin:0 0 18px}
.poker-sound-row{display:flex;gap:16px;align-items:center;justify-content:space-between;min-height:60px;border-top:1px solid #34474A;font-size:16px}.poker-sound-row label{flex:1;line-height:1.4}.poker-sound-volume-row{flex-wrap:wrap;padding:12px 0;gap:4px}
.poker-sound-panel button,.poker-sound-panel select,.poker-sound-panel input{font:inherit;font-size:16px;box-sizing:border-box;min-height:44px}.poker-sound-panel button,.poker-sound-panel select{border:1px solid #34474A;border-radius:8px;background:#22363A;color:#F2EFE7;padding:8px 16px;cursor:pointer;touch-action:manipulation}.poker-sound-panel button[aria-checked=true]{background:#26745A;border-color:#26745A}.poker-sound-panel :focus-visible{outline:2px solid #D6B575;outline-offset:3px}.poker-sound-panel input[type=range]{width:100%;margin:0;accent-color:#D6B575;cursor:pointer;touch-action:pan-x}.poker-sound-panel output{color:#D6B575;font-size:14px}.poker-sound-panel .poker-sound-done{width:100%;margin-top:18px;background:#D6B575;color:#10191D;border-color:#D6B575;font-weight:600}.poker-sound-note{margin:14px 0 0;color:#9BAEAC;font-size:12px;line-height:1.5}
@media(max-height:440px){.poker-sound-panel{padding:14px 20px}.poker-sound-hint,.poker-sound-note{display:none}.poker-sound-row{min-height:44px}.poker-sound-volume-row{flex-wrap:nowrap;padding:0;gap:12px}.poker-sound-volume-row label{flex:0 0 44px}.poker-sound-volume-row input[type=range]{flex:1;width:auto;min-width:0}.poker-sound-done{margin-top:10px!important}}
@supports(padding:max(0px)){.poker-sound-overlay{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right));padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}}
`;

/** Local preferences only; opening the panel does not pause an authoritative poker turn. */
export class SoundPanel {
  private overlay: HTMLDivElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private soundButton: HTMLButtonElement | null = null;
  private alertButton: HTMLButtonElement | null = null;
  private blindsButton: HTMLButtonElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;
  private volume: HTMLInputElement | null = null;
  private volumeOutput: HTMLOutputElement | null = null;
  private speed: HTMLSelectElement | null = null;

  public constructor(private readonly actions: SoundPanelActions) {}
  public get isOpen(): boolean { return this.overlay !== null; }

  public open(): void {
    if (this.overlay) return;
    this.installStyle();
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div'); overlay.className = 'poker-sound-overlay';
    const panel = document.createElement('div'); panel.className = 'poker-sound-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'poker-sound-title'); panel.setAttribute('aria-describedby', 'poker-sound-description');
    const heading = document.createElement('h2'); heading.id = 'poker-sound-title'; heading.textContent = '设置';
    const hint = document.createElement('p'); hint.id = 'poker-sound-description'; hint.className = 'poker-sound-hint'; hint.textContent = '按你的节奏玩 · 设置自动保存在本机'; panel.append(heading, hint);
    this.soundButton = this.toggle(panel, '声音', 'settings-sound', () => ({ soundEnabled: !this.actions.getSettings().soundEnabled }));
    const volumeRow = this.row(panel, '音量', 'poker-sound-volume'); volumeRow.className += ' poker-sound-volume-row';
    this.volumeOutput = document.createElement('output'); this.volumeOutput.setAttribute('for', 'poker-sound-volume'); volumeRow.appendChild(this.volumeOutput);
    this.volume = document.createElement('input'); this.volume.id = 'poker-sound-volume'; this.volume.type = 'range'; this.volume.min = '0'; this.volume.max = '100'; this.volume.step = '1'; this.volume.dataset.action = 'settings-volume'; this.volume.setAttribute('aria-label', '音量'); this.volume.oninput = () => {
      const value = Number(this.volume!.value);
      if (Number.isFinite(value)) this.change({ soundVolume: Math.max(0, Math.min(100, value)) / 100 });
    }; volumeRow.appendChild(this.volume);
    this.alertButton = this.toggle(panel, '行动提醒', 'settings-alerts', () => ({ actionAlertsEnabled: !this.actions.getSettings().actionAlertsEnabled }));
    const speedRow = this.row(panel, '动画速度', 'poker-sound-speed');
    this.speed = document.createElement('select'); this.speed.id = 'poker-sound-speed'; this.speed.dataset.action = 'settings-speed'; this.speed.setAttribute('aria-label', '动画速度');
    for (const [value, text] of [['0.75', '从容 0.75×'], ['1', '标准 1×'], ['1.25', '轻快 1.25×']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; this.speed.appendChild(option); }
    this.speed.onchange = () => { const speed = Number(this.speed!.value); if (speed === 0.75 || speed === 1 || speed === 1.25) this.change({ animationSpeed: speed as AnimationSpeed }); }; speedRow.appendChild(this.speed);
    this.confirmButton = this.toggle(panel, '离开确认', 'settings-confirm', () => ({ confirmReset: !this.actions.getSettings().confirmReset }));
    if (this.actions.onBlinds && this.actions.canConfigureBlinds?.()) {
      const row = this.row(panel, '盲注', 'poker-settings-blinds');
      this.blindsButton = document.createElement('button'); this.blindsButton.type = 'button'; this.blindsButton.id = 'poker-settings-blinds'; this.blindsButton.dataset.action = 'settings-blinds'; this.blindsButton.setAttribute('aria-label', '配置大小盲');
      this.blindsButton.onclick = () => { if (this.isOpen && this.actions.canConfigureBlinds?.()) this.actions.onBlinds?.(); }; row.appendChild(this.blindsButton);
    }
    const note = document.createElement('p'); note.className = 'poker-sound-note'; note.textContent = '行动提醒仅在轮到你和剩余 5 秒时响起。设置面板不会暂停下注计时。'; panel.appendChild(note);
    const done = document.createElement('button'); done.type = 'button'; done.textContent = '完成'; done.className = 'poker-sound-done'; done.dataset.action = 'settings-close'; done.onclick = () => this.close(); panel.appendChild(done);
    for (const name of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'wheel']) overlay.addEventListener(name, event => event.stopPropagation());
    overlay.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button,input,select')).filter(el => !(el as HTMLButtonElement).disabled);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    overlay.appendChild(panel); document.body.appendChild(overlay); this.overlay = overlay; this.refresh(); this.soundButton.focus();
  }

  public close(): void { this.remove(true); }
  public destroy(): void { this.remove(false); }

  private remove(notify: boolean): void {
    if (!this.overlay) return;
    this.overlay.remove(); this.overlay = null; this.blindsButton = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
    if (notify) this.actions.onClose();
  }
  private change(patch: Partial<GameSettings>): void { this.actions.onChange(patch); this.refresh(); }
  public refresh(): void {
    if (!this.isOpen) return;
    const settings = this.actions.getSettings();
    if (this.blindsButton) { const blinds = normalizeBlinds(settings.blinds); this.blindsButton.textContent = `${blinds.smallBlind} / ${blinds.bigBlind}`; this.blindsButton.disabled = !this.actions.canConfigureBlinds?.(); }
    this.setToggle(this.soundButton!, settings.soundEnabled); this.setToggle(this.alertButton!, settings.actionAlertsEnabled); this.setToggle(this.confirmButton!, settings.confirmReset);
    this.volume!.value = String(Math.round(settings.soundVolume * 100)); this.volumeOutput!.textContent = `${Math.round(settings.soundVolume * 100)}%`; this.speed!.value = String(settings.animationSpeed);
  }
  private setToggle(button: HTMLButtonElement, enabled: boolean): void { button.textContent = enabled ? '开启' : '关闭'; button.setAttribute('aria-checked', String(enabled)); }
  private row(panel: HTMLElement, text: string, id: string): HTMLDivElement { const row = document.createElement('div'); row.className = 'poker-sound-row'; const label = document.createElement('label'); label.textContent = text; label.setAttribute('for', id); row.appendChild(label); panel.appendChild(row); return row; }
  private toggle(panel: HTMLElement, label: string, action: string, patch: () => Partial<GameSettings>): HTMLButtonElement { const id = `poker-${action}`; const row = this.row(panel, label, id); const button = document.createElement('button'); button.type = 'button'; button.id = id; button.dataset.action = action; button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label); button.onclick = () => this.change(patch()); row.appendChild(button); return button; }
  private installStyle(): void { if (document.getElementById(STYLE_ID)) return; const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = STYLE; document.head.appendChild(style); }
}
