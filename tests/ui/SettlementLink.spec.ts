import { describe, expect, it } from 'vitest';
import { createSettlementLink } from '../../assets/scripts/ui/SettlementLink';
const shareId = 'A'.repeat(32);
describe('settlement share target', () => {
  it.each([
    ['https://example.test/poker/?room=AB23&token=private#old', 'wss://example.test/ws', `https://example.test/poker/settlement.html?share=${shareId}`],
    ['http://139.199.187.87/index.html?server=old', 'ws://139.199.187.87/ws', `http://139.199.187.87/settlement.html?share=${shareId}`],
    ['http://localhost:8767/?room=AB23', 'ws://localhost:2567', `http://localhost:8767/settlement.html?share=${shareId}`],
  ])('preserves deployed path and exposes only readonly share data for %s', (page, server, expected) => {
    expect(createSettlementLink(page, shareId, server)).toBe(expected);
  });
  it('rejects a custom backend that the public share page cannot reach', () => {
    expect(() => createSettlementLink('https://example.test/poker/', shareId, 'wss://other.test/ws')).toThrow();
  });
  it.each(['file:///game/index.html', 'https://alice:private@example.test/'])('rejects unsupported or credential-bearing page %s', page => {
    expect(() => createSettlementLink(page, shareId, 'wss://example.test/ws')).toThrow();
  });
  it.each(['../private', 'short', 'a&token=secret'])('rejects malformed share identifiers %s', id => {
    expect(() => createSettlementLink('https://example.test/', id, 'wss://example.test/ws')).toThrow();
  });
});
