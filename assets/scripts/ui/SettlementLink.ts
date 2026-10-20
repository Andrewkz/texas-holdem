import { normalizeServerUrl, resolveInvitationServerUrl } from '../net/OnlineCredentials';

export function createSettlementLink(pageUrl: string, shareId: string, activeServerUrl: string): string {
  const page = new URL(pageUrl);
  if (['http:', 'https:'].indexOf(page.protocol) === -1 || page.username || page.password || !/^[A-Za-z0-9_-]{20,128}$/.test(shareId)) {
    throw new Error('无法生成有效的只读结算链接');
  }
  if (normalizeServerUrl(activeServerUrl) !== normalizeServerUrl(resolveInvitationServerUrl(pageUrl))) {
    throw new Error('当前自定义服务器无法通过本站结算页访问，请在对应部署站点分享');
  }
  page.search = ''; page.hash = '';
  const link = new URL('settlement.html', page);
  link.searchParams.set('share', shareId);
  return link.toString();
}
