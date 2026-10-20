const TOP = ['sessionId','shareId','endedAt','expiresAt','reason','recoveryNotice','rows'];
const ROW = ['playerId','nickname','rebuyCount','totalBuyIn','finalChips','net'];
const NOTICE = ['sessionId','tableEpoch','checkpointVersion','rolledBackHandId','reason'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const chips = value => Number.isSafeInteger(value) && value >= 0;

/** Reject hidden fields as well as invalid accounting before rendering a public response. */
export function parsePublicSettlement(raw) {
  if (!exact(raw, TOP) || !id(raw.sessionId) || typeof raw.shareId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(raw.shareId)
    || !chips(raw.endedAt) || !chips(raw.expiresAt) || raw.expiresAt !== raw.endedAt + 30 * 86400000
    || !Number.isFinite(new Date(raw.expiresAt).getTime()) || !['host-ended','last-player-left','all-offline-timeout'].includes(raw.reason)
    || !Array.isArray(raw.rows) || raw.rows.length === 0) return null;
  if (raw.recoveryNotice !== null) {
    const n = raw.recoveryNotice;
    if (!exact(n, NOTICE) || n.sessionId !== raw.sessionId || !id(n.tableEpoch) || !chips(n.checkpointVersion)
      || !Number.isSafeInteger(n.rolledBackHandId) || n.rolledBackHandId <= 0 || !['server-restart','all-offline-timeout'].includes(n.reason)) return null;
  }
  const identities = new Set(); let total = 0;
  for (const row of raw.rows) {
    if (!exact(row, ROW) || !id(row.playerId) || identities.has(row.playerId) || typeof row.nickname !== 'string' || row.nickname.length < 1 || row.nickname.length > 12
      || !chips(row.rebuyCount) || !chips(row.totalBuyIn) || row.totalBuyIn !== (row.rebuyCount + 1) * 5000 || !chips(row.finalChips)
      || !Number.isSafeInteger(row.net) || row.net !== row.finalChips - row.totalBuyIn) return null;
    identities.add(row.playerId); total += row.net;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total === 0 ? raw : null;
}

const number = value => value.toLocaleString('zh-CN');
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
function element(tag, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function showMessage(content, title, description) {
  content.replaceChildren(element('h1', title), element('p', description));
}
async function copySettlementLink(text, input) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* A denied clipboard permission can still allow user-initiated copy. */ }
  const previous = document.activeElement;
  input.focus({ preventScroll: true }); input.select(); input.setSelectionRange?.(0, text.length);
  try {
    if (document.execCommand?.('copy') === true) {
      if (previous?.isConnected && previous !== input) previous.focus({ preventScroll: true });
      return true;
    }
  } catch { /* Leave the full URL selected for manual copy. */ }
  return false;
}
export function renderPublicSettlement(content, settlement, url) {
  content.replaceChildren(element('p', 'PRIVATE TABLE · 只读结算', 'eyebrow'), element('h1', '本场已结束'));
  content.appendChild(element('p', `${settlement.rows.length} 位参与者 · 本场权益已结清`, 'settlement-summary'));
  content.appendChild(element('p', `结束于 ${new Date(settlement.endedAt).toLocaleString('zh-CN')} · 仅使用虚拟筹码`, 'muted'));
  if (settlement.recoveryNotice) content.appendChild(element('p', `未完成的第 ${settlement.recoveryNotice.rolledBackHandId} 手已回退，本页以最近完整结算为准。`, 'notice'));
  const table = element('table'); table.setAttribute('aria-label', '本场全部参与者结算');
  const head = element('thead'), header = element('tr');
  const labels = ['参与者','补码次数','累计投入','最终归属','净盈亏'];
  for (const label of labels) { const th = element('th', label); th.setAttribute('scope', 'col'); header.appendChild(th); }
  head.appendChild(header); table.appendChild(head);
  const body = element('tbody');
  for (const row of settlement.rows) {
    const tr = element('tr');
    const values = [row.nickname, String(row.rebuyCount), number(row.totalBuyIn), number(row.finalChips), signed(row.net)];
    values.forEach((value, index) => {
      const cell = element('td', value, index === 4 ? `net ${row.net < 0 ? 'negative' : row.net > 0 ? 'positive' : 'zero'}` : '');
      cell.setAttribute('data-label', labels[index]); tr.appendChild(cell);
    });
    body.appendChild(tr);
  }
  table.appendChild(body); const scroll = element('div', '', 'table-scroll'); scroll.tabIndex = 0; scroll.appendChild(table); content.appendChild(scroll);
  content.appendChild(element('p', '全体净盈亏合计 0', 'total'));
  content.appendChild(element('p', `有效至 ${new Date(settlement.expiresAt).toLocaleString('zh-CN')}，访问或复制不会延期。`, 'muted'));
  const sharing = element('div', '', 'share-section');
  const label = element('label', '只读分享链接'); const link = element('input'); link.readOnly = true; link.value = url; link.setAttribute('aria-label', '只读分享链接'); link.onclick = () => link.select(); label.appendChild(link); sharing.appendChild(label);
  const status = element('p', '', 'status'); status.setAttribute('role', 'status');
  const copy = element('button', '复制链接'); copy.type = 'button'; copy.dataset.action = 'copy-share';
  copy.onclick = async () => {
    status.textContent = await copySettlementLink(url, link) ? '链接已复制。' : '未能自动复制，请选中完整链接手动复制。';
  };
  sharing.appendChild(copy); content.append(sharing, status);
}

export async function loadPublicSettlement() {
  const content = document.getElementById('settlement-content');
  if (!content) return;
  const values = new URLSearchParams(location.search).getAll('share');
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{20,128}$/.test(values[0])) {
    showMessage(content, '结算链接无效', '请检查好友分享的完整链接。'); return;
  }
  const shareId = values[0], clean = new URL(location.href); clean.search = ''; clean.hash = ''; clean.searchParams.set('share', shareId);
  history.replaceState(null, '', clean);
  showMessage(content, '正在读取结算…', '只读访问不会改变本场状态。');
  try {
    const response = await fetch(`/api/settlements/${encodeURIComponent(shareId)}`, { cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer' });
    if (response.status === 410) { showMessage(content, '结算链接已过期', '本场结算链接自结束起保留 30 天。'); return; }
    if (response.status === 404) { showMessage(content, '未找到本场结算', '请检查链接，或向分享者确认。'); return; }
    if (!response.ok) throw new Error('unavailable');
    const data = parsePublicSettlement(await response.json());
    if (!data || data.shareId !== shareId) throw new Error('invalid');
    renderPublicSettlement(content, data, clean.toString());
  } catch { showMessage(content, '暂时无法读取结算', '请检查网络后刷新重试。'); }
}
if (typeof document !== 'undefined') void loadPublicSettlement();
