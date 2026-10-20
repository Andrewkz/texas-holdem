import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync('build-templates/web-desktop/landscape.js', 'utf8');
class Element {
  id = ''; tagName = 'DIV'; inert = false; hidden = false; src = '';
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add: vi.fn() };
  contentDocument = { activeElement: { tagName: 'BODY', isContentEditable: false } };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}
function boot(options: { ua?: string; mobile?: boolean; width?: number; height?: number; embedded?: boolean; otherFrame?: boolean; ipad?: boolean } = {}) {
  const shell = new Element();
  const frames: Element[] = [];
  const listeners = new Map<string, Function>();
  const orientationListeners = new Map<string, Function>();
  const lock = vi.fn();
  const fullscreen = vi.fn();
  const body = new Element();
  const document: any = {
    body, documentElement: { clientWidth: options.width ?? 390, clientHeight: options.height ?? 844, requestFullscreen: fullscreen },
    querySelector: (selector: string) => selector === '.game-shell' ? shell : null,
    createElement: (tag: string) => { const el = new Element(); el.tagName = tag.toUpperCase(); return el; },
  };
  (body as any).appendChild = (el: Element) => frames.push(el);
  const window: any = {
    navigator: { userAgent: options.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', userAgentData: options.mobile === undefined ? undefined : { mobile: options.mobile }, platform: options.ipad ? 'MacIntel' : 'unknown', maxTouchPoints: options.ipad ? 5 : 0 },
    location: { href: 'https://poker.test/?room=ABC&scope=friend#invite' },
    innerWidth: options.width ?? 390, innerHeight: options.height ?? 844,
    addEventListener: (name: string, listener: Function) => listeners.set(name, listener),
    screen: { orientation: { lock, addEventListener: (name: string, listener: Function) => orientationListeners.set(name, listener) } },
  };
  window.self = window;
  window.parent = options.embedded || options.otherFrame ? {} : window;
  window.frameElement = options.embedded ? { id: 'poker-landscape-frame' } : options.otherFrame ? { id: 'other' } : null;
  runInNewContext(script, { window, document });
  const resize = (width: number, height: number, orientation = false) => {
    window.innerWidth = document.documentElement.clientWidth = width;
    window.innerHeight = document.documentElement.clientHeight = height;
    if (orientation) listeners.get('orientationchange')?.();
    else listeners.get('resize')?.();
  };
  return { shell, frames, body, window, document, resize, lock, fullscreen, listeners };
}

describe('mobile landscape game viewport', () => {
  it('immediately shows mobile portrait as one rotated landscape game and preserves the complete URL', () => {
    const s = boot();
    expect(s.window.__pokerLandscapeHost).toBe(true);
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]).toMatchObject({ id: 'poker-landscape-frame', src: s.window.location.href });
    expect(s.frames[0].style).toMatchObject({ width: '844px', height: '390px', transform: 'translateX(390px) rotate(90deg)', transformOrigin: '0 0' });
    expect(s.shell.hidden).toBe(true); expect(s.shell.inert).toBe(true);
    expect(s.fullscreen).not.toHaveBeenCalled(); expect(s.lock).not.toHaveBeenCalled();
  });
  it('shows mobile landscape without rotation and retains the same iframe across rotations', () => {
    const s = boot({ ua: 'Mozilla/5.0 (Linux; Android 14)', width: 844, height: 390 });
    const frame = s.frames[0];
    expect(frame.style).toMatchObject({ width: '844px', height: '390px', transform: 'none' });
    s.resize(390, 844, true);
    expect(s.frames).toHaveLength(1); expect(s.frames[0]).toBe(frame);
    expect(frame.style.transform).toBe('translateX(390px) rotate(90deg)');
    s.resize(844, 390, true);
    expect(frame.style.transform).toBe('none'); expect(frame.src).toBe(s.window.location.href);
  });
  it('leaves a narrow desktop portrait window untouched', () => {
    const s = boot({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', mobile: false });
    expect(s.frames).toHaveLength(0); expect(s.window.__pokerLandscapeHost).toBeUndefined();
    expect(s.shell.hidden).toBe(false); expect(s.shell.inert).toBe(false);
  });
  it('recognizes mobile UA data and touch iPad desktop user agents', () => {
    expect(boot({ ua: 'unknown', mobile: true }).frames).toHaveLength(1);
    expect(boot({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', ipad: true }).frames).toHaveLength(1);
    expect(boot({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }).frames).toHaveLength(0);
  });
  it('does not create another iframe or skip the engine inside its own game frame', () => {
    const s = boot({ embedded: true });
    expect(s.frames).toHaveLength(0); expect(s.window.__pokerLandscapeHost).toBeUndefined();
    expect(s.shell.hidden).toBe(false);
  });
  it('retains portrait geometry while editing when the virtual keyboard shrinks the viewport', () => {
    const s = boot(); const frame = s.frames[0];
    frame.contentDocument.activeElement.tagName = 'INPUT';
    s.resize(390, 300);
    expect(frame.style).toMatchObject({ width: '844px', height: '390px', transform: 'translateX(390px) rotate(90deg)' });
    frame.contentDocument.activeElement.tagName = 'BODY';
    s.resize(390, 844);
    expect(s.frames).toHaveLength(1);
  });
  it('allows an actual orientation change while a native input remains focused', () => {
    const s = boot(); const frame = s.frames[0];
    frame.contentDocument.activeElement.tagName = 'INPUT';
    s.resize(844, 390, true);
    expect(frame.style).toMatchObject({ width: '844px', height: '390px', transform: 'none' });
  });
  it('handles orientation events that precede the viewport resize while editing', () => {
    const s = boot(); const frame = s.frames[0];
    frame.contentDocument.activeElement.tagName = 'INPUT';
    s.listeners.get('orientationchange')?.();
    s.resize(844, 390);
    expect(frame.style).toMatchObject({ width: '844px', height: '390px', transform: 'none' });
  });
  it('has no orientation prompt and guards only the Cocos startup import', () => {
    const template = readFileSync('build-templates/web-desktop/index.ejs', 'utf8');
    const css = readFileSync('build-templates/web-desktop/style.css', 'utf8');
    expect(template).not.toMatch(/landscape-gate|请横屏|尝试全屏|landscape-status/);
    expect(css).not.toContain('.landscape-gate');
    expect(template).toContain('<script src="landscape.js"></script>');
    expect(template).toContain("throw new Error('Expected one Cocos bootstrap import')");
    expect(template).toContain(".replace('System.import(', 'if (!window.__pokerLandscapeHost) System.import('");
    const included = "System.import('index.js').catch(console.error);";
    const guarded = included.replace('System.import(', 'if (!window.__pokerLandscapeHost) System.import(');
    const imported = vi.fn(() => ({ catch: vi.fn() }));
    runInNewContext(guarded, { window: { __pokerLandscapeHost: true }, System: { import: imported }, console });
    expect(imported).not.toHaveBeenCalled();
    runInNewContext(guarded, { window: {}, System: { import: imported }, console });
    expect(imported).toHaveBeenCalledOnce();
  });
});
