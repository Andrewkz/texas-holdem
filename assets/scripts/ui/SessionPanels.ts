import type { CommandResult, FinalSettlement, LedgerRow, LedgerSnapshot, SessionMeta } from '../net/SessionTypes';
import { copyLink } from './CopyLink';

export interface SessionPanelContext {
  playerId: string;
  hostId: string;
  session: SessionMeta;
  connected: boolean;
  busy: boolean;
  canRejoin: boolean;
}
export interface SessionPanelActions {
  onRebuy(): void;
  onRequestEnd(): void;
  onRejoin(): void;
  onRetryCommand(requestId: string): void;
  onClose(): void;
  onInteract?(): void;
}

/** DOM presentation only. The server owns balances, eligibility, and command outcomes. */
export class SessionPanels {
  private overlay: HTMLDivElement | null = null;
  private panel: HTMLDivElement | null = null;
  private live: HTMLParagraphElement | null = null;
  private mode: 'ledger' | 'rebuy' | 'end' | 'left' | 'ended' | 'identities' | null = null;
  private ledger: LedgerSnapshot | null = null;
  private context: SessionPanelContext | null = null;
  private previousFocus: HTMLElement | null = null;
  private notice = '';
  private lastResult: CommandResult | null = null;
  private readonly unknownRequests = new Set<string>();
  private confirming = false;

  public constructor(private readonly actions: SessionPanelActions) {}
  public get isOpen(): boolean { return this.overlay !== null; }
  public get showingFinal(): boolean { return this.mode === 'ended'; }

  public updateLedger(ledger: LedgerSnapshot, context: SessionPanelContext): void {
    this.ledger = ledger; this.context = context;
    if (this.mode === 'ledger') this.renderLedger(ledger, context);
    if (this.mode === 'left' && this.self()?.seatStatus !== 'seated' && this.self()) this.renderLedger(ledger, context, true);
    if (this.mode === 'rebuy' && !this.canRebuy()) this.renderLedger(ledger, context);
    if (this.mode === 'end' && !this.canEnd()) this.renderLedger(ledger, context);
  }

  public renderLedger(ledger: LedgerSnapshot, context: SessionPanelContext, left = false): void {
    this.ledger = ledger; this.context = context; this.mode = left ? 'left' : 'ledger';
    const panel = this.open(left ? '你已离开座位' : '本场账本');
    this.paragraph(panel, left ? '本场身份已保留，重入沿用已有筹码和累计投入。' : '仅计入完整手结算 · 当前手输赢尚未计入', 'session-subtitle');
    if (this.notice) this.paragraph(panel, this.notice, 'session-note');
    if (context.session.lifecycle === 'ending-after-hand') this.paragraph(panel, '本手结算后结束本场，不再发下一手。', 'session-note');
    if (context.session.lifecycle === 'all-offline-wait') this.paragraph(panel, '本场正在等待连接恢复。', 'session-note');
    const list = this.element('div', 'session-ledger-list');
    for (const row of ledger.rows) list.appendChild(this.ledgerRow(row));
    panel.appendChild(list);
    this.createStatus(panel);
    const footer = this.element('div', 'session-panel-actions');
    if (!left) {
      this.button(footer, this.self()?.pendingRebuyRequestId ? '补码待下一手生效' : '免费补至 5,000', () => this.confirmRebuy(), !this.canRebuy(), 'session-rebuy');
      this.button(footer, '结束本场', () => this.confirmEnd(), !this.canEnd(), 'session-end');
    }
    if (left && context.canRejoin) this.button(footer, '返回原场', () => this.actions.onRejoin(), context.busy, 'session-rejoin');
    this.button(footer, left ? '返回首页' : '关闭', () => this.close(), false, 'session-close');
    panel.appendChild(footer);
  }

  public renderEnded(settlement: FinalSettlement, shareUrl: string): void {
    this.mode = 'ended';
    const panel = this.open('本场已结束');
    this.paragraph(panel, settlement.reason === 'all-offline-timeout' ? '全员断线等待期已结束。' : settlement.reason === 'last-player-left' ? '最后一位玩家已离开，本场权益已结清。' : '本场权益已结清。');
    if (settlement.recoveryNotice) this.paragraph(panel, `未完成的第 ${settlement.recoveryNotice.rolledBackHandId} 手已回退，结算以最近完整手为准。`, 'session-note');
    const list = this.element('div', 'session-ledger-list');
    for (const row of settlement.rows) {
      const card = this.element('article', 'session-ledger-row');
      const heading = this.element('h3'); heading.textContent = row.nickname; card.appendChild(heading);
      this.paragraph(card, `补码 ${row.rebuyCount} 次`, 'session-row-status');
      this.metric(card, '净盈亏', signedChips(row.net), 'session-net');
      this.metric(card, '累计投入', chips(row.totalBuyIn));
      this.metric(card, '最终归属', chips(row.finalChips));
      card.setAttribute('data-net', row.net > 0 ? 'positive' : row.net < 0 ? 'negative' : 'zero');
      list.appendChild(card);
    }
    panel.appendChild(list);
    const sum = settlement.rows.reduce((total, row) => total + row.net, 0);
    this.paragraph(panel, `全体净盈亏合计 ${signedChips(sum)}`, sum === 0 ? 'session-total' : 'session-error');
    this.paragraph(panel, shareUrl ? '只读结算 · 自本场结束起 30 天有效' : '当前自定义服务器没有对应的本站分享入口；本场结算仍可在此查看。', 'session-subtitle');
    const link = this.element('input', 'session-share-link'); link.readOnly = true; link.value = shareUrl; link.setAttribute('aria-label', '只读结算分享链接'); link.onclick = () => link.select(); if (shareUrl) panel.appendChild(link);
    this.createStatus(panel);
    const footer = this.element('div', 'session-panel-actions');
    this.button(footer, '复制结算链接', () => { void this.copyLink(link); }, !shareUrl, 'session-copy');
    this.button(footer, '返回首页', () => this.close(), false, 'session-close'); panel.appendChild(footer);
  }

  public renderLeaveResult(result: CommandResult, freshLedger: LedgerSnapshot | null, context: SessionPanelContext | null): void {
    const self = freshLedger?.sessionId === result.sessionId ? freshLedger.rows.find(row => row.playerId === context?.playerId) : undefined;
    if (freshLedger && context && self && self.seatStatus !== 'seated' && result.status !== 'rejected') {
      this.renderLedger(freshLedger, context, true);
    } else {
      this.renderLeft(result.code === 'confirmation-unknown'
        ? '离座结果待确认，请查询原请求；当前不显示暂估余额。'
        : result.status === 'rejected' ? '离座请求尚未生效；本场证明仍保留，可恢复原身份后核对状态。'
          : '离座请求已确认；当前未取得离座后的账本。若有未结清权益，待本手结清后确定归属，不显示暂估余额。');
    }
  }

  public renderLeft(message: string): void {
    this.mode = 'left';
    const panel = this.open('本场身份已保留');
    this.paragraph(panel, message);
    this.paragraph(panel, '返回原场将沿用原身份与已结清筹码，不重复领取初始筹码；若本手权益尚未结清，请结清后再返回。');
    this.createStatus(panel);
    const footer = this.element('div', 'session-panel-actions');
    this.button(footer, '返回原场', () => this.actions.onRejoin(), false, 'session-rejoin');
    this.button(footer, '返回首页', () => this.close(), false, 'session-close'); panel.appendChild(footer);
  }

  public showCommandResult(result: CommandResult): void {
    this.lastResult = result;
    if (result.code !== 'confirmation-unknown') {
      this.unknownRequests.delete(result.requestId);
      this.panel?.querySelector(`[data-request-id="${result.requestId}"]`)?.remove();
    }
    if (!this.isOpen || this.showingFinal) return;
    const text = commandMessage(result) || (result.status === 'rejected' ? '操作未生效，请查看当前状态后重试。' : result.status === 'pending' ? '请求已接受，等待生效。' : '操作已完成。');
    if (this.live) this.live.textContent = text;
  }

  public showUnknownCommand(requestId: string): void {
    const alreadyShown = this.unknownRequests.has(requestId);
    this.unknownRequests.add(requestId);
    if (!this.panel || this.showingFinal) return;
    if (this.live) this.live.textContent = '尚未确认结果，请查询原请求，避免重复操作。';
    if (alreadyShown && this.panel.querySelector(`[data-request-id="${requestId}"]`)) return;
    this.button(this.panel, '查询操作结果', () => this.actions.onRetryCommand(requestId), false, 'session-query');
    this.panel.lastElementChild?.setAttribute('data-request-id', requestId);
  }

  public showNotice(text: string): void {
    this.notice = text;
    if (this.live && !this.showingFinal) this.live.textContent = text;
  }

  public renderSavedSessions(sessions: { nickname: string; roomCode: string }[], onSelect: (index: number) => void): void {
    this.mode = 'identities';
    const panel = this.open('返回原场 / 查看结算');
    this.paragraph(panel, '选择已保存的本场身份。返回时沿用原筹码与累计投入，不重复领取初始筹码。');
    const list = this.element('div', 'session-panel-actions session-saved-identities');
    sessions.forEach((session, index) => this.button(list, `${session.nickname} · 房间 ${session.roomCode}`, () => onSelect(index), false, 'session-select'));
    this.button(list, '关闭', () => this.close(), false, 'session-close'); panel.appendChild(list);
  }

  public close(notify = true): void {
    this.confirming = false;
    this.overlay?.remove(); this.overlay = null; this.panel = null; this.live = null; this.mode = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus(); this.previousFocus = null;
    if (notify) this.actions.onClose();
  }
  public destroy(): void { this.close(false); this.ledger = null; this.context = null; this.unknownRequests.clear(); this.lastResult = null; this.notice = ''; }

  private self(): LedgerRow | undefined { return this.ledger?.rows.find(row => row.playerId === this.context?.playerId); }
  private canRebuy(): boolean {
    const row = this.self(), c = this.context;
    return Boolean(c?.connected && !c.busy && c.session.lifecycle === 'active' && row?.seatStatus === 'seated' && row.stack === 0 && row.pendingDepartureHandId === null && row.pendingRebuyRequestId === null);
  }
  private canEnd(): boolean {
    const c = this.context;
    return Boolean(c?.connected && !c.busy && c.playerId === c.hostId && c.session.lifecycle === 'active');
  }
  private confirmRebuy(): void {
    if (!this.canRebuy()) return;
    this.mode = 'rebuy'; const panel = this.open('免费补码？');
    this.paragraph(panel, '确认后排队免费补至 5,000，从下一手开始生效，并计入本场累计投入。');
    this.live = this.paragraph(panel, '', 'session-live');
    const footer = this.element('div', 'session-panel-actions');
    this.button(footer, '确认补码', () => { if (this.canRebuy() && !this.confirming) { this.confirming = true; this.actions.onRebuy(); } }, false, 'session-rebuy-confirm');
    this.button(footer, '取消', () => this.renderLedger(this.ledger!, this.context!), false, 'session-confirm-cancel'); panel.appendChild(footer);
  }
  private confirmEnd(): void {
    if (!this.canEnd()) return;
    this.mode = 'end'; const panel = this.open('结束本场？');
    this.paragraph(panel, '若当前手尚未结束，将在完整结算后结束本场，不再发下一手。');
    this.live = this.paragraph(panel, '', 'session-live');
    const footer = this.element('div', 'session-panel-actions');
    this.button(footer, '确认结束', () => { if (this.canEnd() && !this.confirming) { this.confirming = true; this.actions.onRequestEnd(); } }, false, 'session-end-confirm');
    this.button(footer, '取消', () => this.renderLedger(this.ledger!, this.context!), false, 'session-confirm-cancel'); panel.appendChild(footer);
  }
  private createStatus(panel: HTMLElement): void {
    this.live = this.paragraph(panel, this.showingFinal ? '' : this.notice, 'session-live'); this.live.setAttribute('role', 'status');
    if (!this.showingFinal && this.lastResult) this.showCommandResult(this.lastResult);
    if (!this.showingFinal) this.unknownRequests.forEach(requestId => {
      this.button(panel, '查询操作结果', () => this.actions.onRetryCommand(requestId), false, 'session-query');
      panel.lastElementChild?.setAttribute('data-request-id', requestId);
    });
  }

  private open(title: string): HTMLDivElement {
    this.confirming = false;
    if (!this.overlay) {
      const active = document.activeElement;
      this.previousFocus = active instanceof HTMLElement ? active : null;
      if (active instanceof HTMLInputElement) active.blur();
      this.overlay = this.element('div', 'poker-session-overlay');
      this.overlay.addEventListener('pointerdown', event => event.stopPropagation());
      this.overlay.addEventListener('click', event => event.stopPropagation());
      document.body.appendChild(this.overlay);
    }
    this.overlay.replaceChildren();
    const panel = this.element('div', 'poker-session-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'poker-session-title'); panel.dataset.mode = this.mode ?? ''; panel.tabIndex = -1;
    const heading = this.element('h2'); heading.setAttribute('id', 'poker-session-title'); heading.textContent = title; panel.appendChild(heading); this.overlay.appendChild(panel); this.panel = panel;
    panel.focus({ preventScroll: true });
    return panel;
  }
  private ledgerRow(row: LedgerRow): HTMLElement {
    const card = this.element('article', 'session-ledger-row');
    const heading = this.element('h3'); heading.textContent = `${row.nickname}${row.playerId === this.context?.playerId ? ' · 你' : ''}`; card.appendChild(heading);
    card.setAttribute('data-pending', String(row.pendingDepartureHandId !== null));
    const status = row.seatStatus === 'leaving-hand' ? '本手权益待结清' : row.seatStatus === 'left' ? '已离座' : '在座';
    this.paragraph(card, `${status} · 补码 ${row.rebuyCount} 次`, 'session-row-status');
    if (row.pendingDepartureHandId !== null) this.paragraph(card, '离场归属：待本手结清', 'session-pending');
    else {
      this.metric(card, '已结算盈亏', signedChips(row.stack + row.releasedChips - row.totalBuyIn), 'session-net');
      this.metric(card, '已结算在桌', chips(row.stack));
      this.metric(card, '离场归属', chips(row.releasedChips));
    }
    this.metric(card, '累计投入', chips(row.totalBuyIn));
    if (row.pendingRebuyRequestId) this.paragraph(card, '免费补码待下一手生效', 'session-note');
    return card;
  }
  private metric(parent: HTMLElement, label: string, value: string, className = ''): void {
    const metric = this.element('div', `session-metric ${className}`.trim());
    const caption = this.element('span'); caption.textContent = `${label} `;
    const amount = this.element('strong'); amount.textContent = value;
    metric.appendChild(caption); metric.appendChild(amount); parent.appendChild(metric);
  }
  private async copyLink(input: HTMLInputElement): Promise<void> {
    const live = this.live;
    const result = await copyLink(input.value, input);
    if (live === this.live && live) live.textContent = result === 'copied' ? '结算链接已复制。' : '未能自动复制，请选中上方完整链接手动复制。';
  }
  private element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.className = className; return node;
  }
  private paragraph(parent: HTMLElement, text: string, className = ''): HTMLParagraphElement {
    const node = this.element('p', className); node.textContent = text; parent.appendChild(node); return node;
  }
  private button(parent: HTMLElement, text: string, onClick: () => void, disabled: boolean, testId: string): void {
    const node = this.element('button'); node.type = 'button'; node.textContent = text; node.disabled = disabled; node.dataset.action = testId;
    node.onclick = () => { if (!node.disabled) { this.actions.onInteract?.(); onClick(); } }; parent.appendChild(node);
  }
}

function chips(value: number): string { return value.toLocaleString('zh-CN'); }
function signedChips(value: number): string { return `${value > 0 ? '+' : ''}${chips(value)}`; }

function commandMessage(result: CommandResult): string | undefined {
  const messages: Record<string, string> = {
    'rebuy-ineligible': '当前未满足补码条件，请待完整手结算且余额为零后再确认。',
    'rebuy-pending': '补码已排队，将在下一手开始时生效，请勿重复申请。',
    'pending-equity': '本手权益尚未结清；待本手结清后再返回原场。',
    'request-conflict': '请求编号冲突，请先核对原请求结果，避免重复操作。',
    'storage-failed': '本场保存遇到问题，结果尚未确认；请查询原请求，勿重复操作。',
    'command-not-found': '暂未找到原请求，请核对当前状态并保留原请求编号。',
    'confirmation-unknown': '结果待确认，请查询原请求，避免重复操作。',
  };
  return messages[result.code ?? ''] || result.message;
}
