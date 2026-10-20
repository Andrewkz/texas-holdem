import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPanelActions, SessionPanelContext, SessionPanels } from '../../assets/scripts/ui/SessionPanels';
import { LedgerSnapshot } from '../../assets/scripts/net/SessionTypes';

// A deliberately small DOM fixture exercises presenter behavior without loading Cocos.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  className = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  disabled = false;
  value = '';
  private ownText = '';
  onclick: (() => void) | null = null;
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get lastElementChild(): Element | null { return this.children[this.children.length - 1] ?? null; }
  get isConnected(): boolean { return this === doc.body || Boolean(this.parent?.isConnected); }
  appendChild(child: Element): Element { child.parent = this; this.children.push(child); return child; }
  replaceChildren(): void { this.children.forEach(child => child.parent = null); this.children = []; this.ownText = ''; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttributeNames(): string[] { return Object.keys(this.attributes); }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  addEventListener(): void {}
  focus(): void { doc.activeElement = this; }
  blur(): void { doc.activeElement = doc.body; }
  querySelector(selector: string): Element | null { return descendants(this).find(node => selector === `[data-request-id="${node.attributes['data-request-id']}"]`) ?? null; }
}
class Input extends Element { selected = false; select(): void { this.selected = true; } }
let doc: { body: Element; activeElement: Element; createElement: (tag: string) => Element };
function descendants(root: Element): Element[] { return root.children.reduce<Element[]>((all, child) => all.concat(child, descendants(child)), []); }
function action(name: string): Element { const node = descendants(doc.body).find(node => node.dataset.action === name); expect(node, name).toBeDefined(); return node!; }
function click(name: string): void { action(name).onclick?.(); }
let actions: SessionPanelActions;
let panels: SessionPanels;
let context: SessionPanelContext;
let ledger: LedgerSnapshot;

beforeEach(() => {
  doc = { body: new Element(), activeElement: new Element(), createElement: tag => tag === 'input' ? new Input() : new Element() };
  vi.stubGlobal('document', doc); vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('HTMLInputElement', Input);
  vi.stubGlobal('navigator', {});
  actions = { onRebuy: vi.fn(), onRequestEnd: vi.fn(), onRejoin: vi.fn(), onRetryCommand: vi.fn(), onClose: vi.fn() };
  panels = new SessionPanels(actions);
  context = { playerId: 'p1', hostId: 'p1', session: { sessionId: 's1', tableEpoch: 'e1', lifecycle: 'active', checkpointVersion: 1, allOfflineDeadline: null }, connected: true, busy: false, canRejoin: false };
  ledger = { sessionId: 's1', committedHandId: 1, rows: [{ playerId: 'p1', nickname: '<img onerror=evil()>', seatStatus: 'seated', stack: 0, releasedChips: 0, totalBuyIn: 5000, rebuyCount: 0, pendingDepartureHandId: null, pendingRebuyRequestId: null }] };
});
afterEach(() => { panels.destroy(); vi.unstubAllGlobals(); });

describe('session panels', () => {
  it('announces the dialog title and plays one interaction sound for each enabled button', () => {
    actions.onInteract = vi.fn();
    panels.renderLedger(ledger, context);
    const dialog = descendants(doc.body).find(node => node.attributes.role === 'dialog')!;
    const heading = dialog.children[0];
    expect(dialog.attributes['aria-labelledby']).toBe(heading.attributes.id);
    expect(heading.attributes.id).toBeTruthy();
    click('session-rebuy');
    expect(actions.onInteract).toHaveBeenCalledTimes(1);
    click('session-confirm-cancel');
    expect(actions.onInteract).toHaveBeenCalledTimes(2);
    panels.renderLedger(ledger, { ...context, connected: false });
    click('session-rebuy');
    expect(actions.onInteract).toHaveBeenCalledTimes(2);
  });

  it('confirms once, cancels without sending, and blocks disconnected or busy commands', () => {
    panels.renderLedger(ledger, context);
    click('session-rebuy'); click('session-confirm-cancel'); expect(actions.onRebuy).not.toHaveBeenCalled();
    click('session-rebuy'); click('session-rebuy-confirm'); click('session-rebuy-confirm'); expect(actions.onRebuy).toHaveBeenCalledTimes(1);
    panels.renderLedger(ledger, { ...context, connected: false }); expect(action('session-rebuy').disabled).toBe(true); expect(action('session-end').disabled).toBe(true);
    panels.renderLedger(ledger, { ...context, busy: true }); expect(action('session-rebuy').disabled).toBe(true);
    panels.renderLedger(ledger, context); click('session-end'); click('session-end-confirm'); click('session-end-confirm'); expect(actions.onRequestEnd).toHaveBeenCalledTimes(1);
  });

  it('uses settled eligibility, explains queued rebuy and pending departure without a final estimate', () => {
    ledger.rows[0].stack = 5000;
    panels.renderLedger(ledger, context); expect(action('session-rebuy').disabled).toBe(true);
    ledger.rows[0].stack = 0; ledger.rows[0].pendingRebuyRequestId = 'rebuy-1';
    panels.updateLedger(ledger, context); expect(action('session-rebuy').disabled).toBe(true); expect(doc.body.textContent).toContain('补码待下一手生效');
    ledger.rows[0].pendingDepartureHandId = 2; ledger.rows[0].seatStatus = 'leaving-hand';
    panels.renderLedger(ledger, context, true);
    expect(doc.body.textContent).toContain('本手权益待结清'); expect(doc.body.textContent).not.toContain('已结算盈亏');
    expect(descendants(doc.body).filter(node => node.className === 'session-ledger-row')[0].children[0].textContent).toBe('<img onerror=evil()> · 你');
  });

  it('retains original unknown request through ledger updates and clears its query after a known receipt', () => {
    panels.renderLedger(ledger, context);
    panels.showCommandResult({ sessionId: 's1', requestId: 'original-1', command: 'rebuy', status: 'pending', code: 'confirmation-unknown' });
    panels.showUnknownCommand('original-1'); panels.updateLedger(ledger, context); click('session-query');
    expect(actions.onRetryCommand).toHaveBeenCalledWith('original-1');
    panels.showCommandResult({ sessionId: 's1', requestId: 'original-1', command: 'rebuy', status: 'committed' });
    expect(descendants(doc.body).filter(node => node.dataset.action === 'session-query').length).toBe(0);
  });

  it('keeps final settlement authoritative over late command results and supports copy failure', async () => {
    panels.renderEnded({ sessionId: 's1', shareId: 'share', endedAt: 1, expiresAt: 2, reason: 'host-ended', recoveryNotice: null, rows: [{ playerId: 'p1', nickname: '甲', rebuyCount: 0, totalBuyIn: 5000, finalChips: 5000, net: 0 }] }, 'https://poker.test/settlement.html?share=abc');
    panels.showCommandResult({ sessionId: 's1', requestId: 'late', command: 'leaveRoom', status: 'rejected', message: '错误的迟到结果' });
    panels.showUnknownCommand('late');
    expect(doc.body.textContent).not.toContain('错误的迟到结果'); expect(doc.body.textContent).toContain('全体净盈亏合计 0');
    click('session-copy'); await Promise.resolve();
    expect(doc.body.textContent).toContain('手动复制'); expect((descendants(doc.body).find(node => node instanceof Input) as Input).selected).toBe(true);
  });

  it('copies a settlement link from an HTTP page with no modern clipboard API', async () => {
    let copied = '';
    Object.assign(doc, { execCommand: (command: string) => { const input = doc.activeElement as Input; if (command !== 'copy' || !input.selected) return false; copied = input.value; return true; } });
    panels.renderEnded({ sessionId: 's1', shareId: 'share', endedAt: 1, expiresAt: 2, reason: 'host-ended', recoveryNotice: null, rows: [{ playerId: 'p1', nickname: '甲', rebuyCount: 0, totalBuyIn: 5000, finalChips: 5000, net: 0 }] }, 'http://poker.test/settlement.html?share=abc');
    click('session-copy'); await Promise.resolve(); await Promise.resolve();
    expect(copied).toBe('http://poker.test/settlement.html?share=abc');
    expect(doc.body.textContent).toContain('已复制'); expect(doc.body.textContent).not.toContain('手动复制');
  });

  it('renders saved identities without transmitting until explicit selection and never fabricates a left balance', () => {
    const select = vi.fn();
    panels.renderSavedSessions([{ nickname: '甲', roomCode: 'ABCD' }, { nickname: '乙', roomCode: 'WXYZ' }], select);
    expect(select).not.toHaveBeenCalled(); click('session-select'); expect(select).toHaveBeenCalledWith(0);
    panels.renderLeft('本手权益尚未结清'); expect(doc.body.textContent).not.toContain('5,000'); click('session-rejoin'); expect(actions.onRejoin).toHaveBeenCalledOnce();
  });

  it('does not show cached seated balances as confirmed departure ownership', () => {
    ledger.rows[0].stack = 5000;
    panels.renderLeaveResult({ sessionId: 's1', requestId: 'leave-1', command: 'leaveRoom', status: 'committed' }, ledger, context);
    expect(doc.body.textContent).not.toContain('已结算在桌');
    expect(doc.body.textContent).not.toContain('离场归属 0');
    panels.updateLedger(ledger, { ...context, busy: true });
    expect(doc.body.textContent).not.toContain('已结算在桌');
    expect(doc.body.textContent).toContain('待本手结清');
    panels.renderLeaveResult({ sessionId: 's1', requestId: 'leave-1', command: 'leaveRoom', status: 'committed' }, { ...ledger, rows: [{ ...ledger.rows[0], seatStatus: 'left', stack: 0, releasedChips: 5000 }] }, context);
    expect(doc.body.textContent).toContain('离场归属 5,000');
  });

  it.each([
    ['rebuy-ineligible', '未满足补码条件'], ['rebuy-pending', '补码已排队'], ['pending-equity', '待本手结清'],
    ['request-conflict', '请求编号冲突'], ['storage-failed', '结果尚未确认'], ['command-not-found', '未找到原请求'], ['confirmation-unknown', '结果待确认'],
  ])('explains %s in Chinese instead of exposing the internal error', (code, expected) => {
    panels.renderLedger(ledger, context);
    panels.showCommandResult({ sessionId: 's1', requestId: 'command-1', command: 'rebuy', status: 'rejected', code, message: 'Internal English ledger error' });
    expect(doc.body.textContent).toContain(expected);
    expect(doc.body.textContent).not.toContain('Internal English');
  });

  it('makes rollback visible and removes old notices and receipts for the next admitted session', () => {
    panels.renderLedger(ledger, context); panels.showNotice('第 2 手已回退');
    expect(doc.body.textContent).toContain('第 2 手已回退');
    panels.destroy(); panels.renderLedger({ ...ledger, sessionId: 's2' }, { ...context, session: { ...context.session, sessionId: 's2' } });
    expect(doc.body.textContent).not.toContain('第 2 手已回退');
  });
});
