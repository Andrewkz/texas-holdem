import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyLink } from '../../assets/scripts/ui/CopyLink';

const link = 'http://poker.test/?room=ABCD&server=ws%3A%2F%2Fpoker.test%2Fws';
class Field {
  value = ''; readOnly = false; style: Record<string, string> = {}; attributes: Record<string, string> = {};
  selected = ''; isConnected = true;
  focus(): void { doc.activeElement = this; }
  select(): void { this.selected = this.value; }
  setSelectionRange(start: number, end: number): void { this.selected = this.value.slice(start, end); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  remove(): void { this.isConnected = false; created = created.filter(field => field !== this); }
}
let created: Field[], doc: { activeElement: Field; body: { appendChild(field: Field): void }; createElement(): Field; execCommand?: (command: string) => boolean };
let clipboard = '';
function field(): HTMLInputElement { const value = new Field(); value.value = link; return value as unknown as HTMLInputElement; }
function enableLegacyCopy(): void {
  doc.execCommand = command => { if (command !== 'copy') return false; clipboard = doc.activeElement.selected; return clipboard.length > 0; };
}
beforeEach(() => {
  clipboard = ''; created = [];
  doc = { activeElement: new Field(), body: { appendChild(value) { created.push(value); } }, createElement: () => new Field() };
  vi.stubGlobal('document', doc); vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('copy link across secure and HTTP browsers', () => {
  it('copies the exact full URL through the modern clipboard without changing focus', async () => {
    vi.stubGlobal('navigator', { clipboard: { async writeText(text: string) { clipboard = text; } } });
    const focus = doc.activeElement;
    expect(await copyLink(link, field())).toBe('copied');
    expect(clipboard).toBe(link); expect(doc.activeElement).toBe(focus);
  });
  it('copies on HTTP without the modern API and restores the invoking control focus', async () => {
    enableLegacyCopy(); const focus = doc.activeElement;
    expect(await copyLink(link, field())).toBe('copied');
    expect(clipboard).toBe(link); expect(doc.activeElement).toBe(focus);
  });
  it('falls back when modern clipboard permission is rejected', async () => {
    vi.stubGlobal('navigator', { clipboard: { async writeText() { throw new Error('denied'); } } });
    enableLegacyCopy();
    expect(await copyLink(link, field())).toBe('copied'); expect(clipboard).toBe(link);
  });
  it.each(['denied', 'throws', 'unavailable'])('keeps the whole URL selected for manual copy when legacy copy is %s', async mode => {
    if (mode !== 'unavailable') doc.execCommand = () => { if (mode === 'throws') throw new Error('denied'); return false; };
    const input = field();
    expect(await copyLink(link, input)).toBe('manual');
    expect(doc.activeElement).toBe(input); expect((input as unknown as Field).selected).toBe(link); expect(clipboard).toBe('');
  });
  it('removes a temporary field after successful copy when the caller has no input', async () => {
    enableLegacyCopy(); expect(await copyLink(link)).toBe('copied'); expect(clipboard).toBe(link); expect(created).toHaveLength(0);
  });
  it('leaves an accessible selected field for manual copy if no input was supplied', async () => {
    expect(await copyLink(link)).toBe('manual');
    expect(created).toHaveLength(1); expect(created[0].selected).toBe(link);
    expect(created[0].attributes['aria-label']).toBeTruthy();
  });
});
