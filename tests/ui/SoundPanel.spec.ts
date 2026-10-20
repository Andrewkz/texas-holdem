import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoundPanel } from '../../assets/scripts/ui/SoundPanel';
import { DEFAULT_GAME_SETTINGS, GameSettings } from '../../assets/scripts/ui/GameSettings';
class Element {
 children:Element[]=[];parent:Element|null=null;className='';id='';textContent='';attributes:Record<string,string>={};dataset:Record<string,string>={};value='';type='';disabled=false;tabIndex=0;
 onclick:Function|null=null;oninput:Function|null=null;onchange:Function|null=null;onkeydown:Function|null=null;listeners=new Map<string,Function>();
 appendChild(e:Element){e.parent=this;this.children.push(e);return e} append(...els:Element[]){els.forEach(e=>this.appendChild(e))} remove(){if(this.parent)this.parent.children=this.parent.children.filter(e=>e!==this);this.parent=null}
 setAttribute(k:string,v:string){this.attributes[k]=v} addEventListener(k:string,fn:Function){this.listeners.set(k,fn)}
 focus(){doc.activeElement=this} get isConnected():boolean{return this===doc.body||this===doc.head||!!this.parent?.isConnected}
 querySelectorAll(){return descendants(this).filter(e=>['button','input','select'].includes(e.tag))} constructor(public tag='div'){}
}
function descendants(el:Element):Element[]{return el.children.flatMap(e=>[e,...descendants(e)])}
let doc:any;let settings:GameSettings;let panel:SoundPanel;let change:ReturnType<typeof vi.fn>;let close:ReturnType<typeof vi.fn>;
function action(name:string){const el=descendants(doc.body).find(e=>e.dataset.action===name);expect(el,name).toBeDefined();return el!}
beforeEach(()=>{
 doc={body:new Element('body'),head:new Element('head'),activeElement:null,createElement:(t:string)=>new Element(t),getElementById:(id:string)=>[...descendants(doc.head),...descendants(doc.body)].find(e=>e.id===id)??null};
 vi.stubGlobal('document',doc);vi.stubGlobal('HTMLElement',Element);settings={...DEFAULT_GAME_SETTINGS};change=vi.fn((p:Partial<GameSettings>)=>settings={...settings,...p});close=vi.fn();panel=new SoundPanel({getSettings:()=>settings,onChange:change,onClose:close});
});
afterEach(()=>{panel.destroy();vi.unstubAllGlobals()});
describe('sound and play settings dialog',()=>{
 it('contains all five independent settings and changes them without closing or resetting others',()=>{
  panel.open();expect(panel.isOpen).toBe(true);action('settings-sound').onclick?.();expect(settings.soundEnabled).toBe(false);
  const volume=action('settings-volume');volume.value='35';volume.oninput?.();expect(settings.soundVolume).toBe(0.35);
  action('settings-alerts').onclick?.();expect(settings.actionAlertsEnabled).toBe(false);
  const speed=action('settings-speed');speed.value='1.25';speed.onchange?.();expect(settings.animationSpeed).toBe(1.25);
  action('settings-confirm').onclick?.();expect(settings.confirmReset).toBe(false);expect(panel.isOpen).toBe(true);expect(settings.soundVolume).toBe(0.35);
 });
 it('does not duplicate an open dialog, restores focus, and notifies close exactly once',()=>{
  const origin=new Element('button');doc.body.appendChild(origin);origin.focus();panel.open();panel.open();expect(descendants(doc.body).filter(e=>e.attributes.role==='dialog')).toHaveLength(1);
  action('settings-close').onclick?.();expect(panel.isOpen).toBe(false);expect(doc.activeElement).toBe(origin);expect(close).toHaveBeenCalledOnce();panel.close();expect(close).toHaveBeenCalledOnce();
 });
 it('closes with Escape, traps keyboard focus and stops pointer propagation without preventing slider input',()=>{
  panel.open();const overlay=doc.body.children[0];const stop=vi.fn();overlay.listeners.get('pointerdown')?.({stopPropagation:stop});expect(stop).toHaveBeenCalledOnce();
  const button=action('settings-close');button.focus();const prevent=vi.fn();overlay.onkeydown?.({key:'Tab',shiftKey:false,preventDefault:prevent,stopPropagation:stop});expect(prevent).toHaveBeenCalled();expect(doc.activeElement).toBe(action('settings-sound'));
  overlay.onkeydown?.({key:'Escape',preventDefault:prevent,stopPropagation:stop});expect(close).toHaveBeenCalledOnce();
 });
 it('omits blind configuration by default and when a running table disables configuration',()=>{
  panel.open();expect(descendants(doc.body).some(e=>e.dataset.action==='settings-blinds')).toBe(false);panel.destroy();
  panel=new SoundPanel({getSettings:()=>settings,onChange:change,onClose:close,onBlinds:vi.fn(),canConfigureBlinds:()=>false});panel.open();expect(descendants(doc.body).some(e=>e.dataset.action==='settings-blinds')).toBe(false);
 });
 it('opens blind settings from home without dismissing sound settings, refreshes new stakes and rechecks eligibility',()=>{
  let eligible=true;const blinds=vi.fn();panel=new SoundPanel({getSettings:()=>settings,onChange:change,onClose:close,onBlinds:blinds,canConfigureBlinds:()=>eligible});
  panel.open();expect(action('settings-blinds').textContent).toBe('20 / 40');action('settings-blinds').onclick?.();expect(blinds).toHaveBeenCalledOnce();expect(panel.isOpen).toBe(true);expect(close).not.toHaveBeenCalled();
  settings={...settings,blinds:{smallBlind:50,bigBlind:100}};panel.refresh();expect(action('settings-blinds').textContent).toBe('50 / 100');eligible=false;action('settings-blinds').onclick?.();expect(blinds).toHaveBeenCalledOnce();
  panel.close();panel.refresh();expect(panel.isOpen).toBe(false);
 });
 it('uses the approved palette, scrollable compact panel and minimum controls in injected CSS',()=>{
  panel.open();const style=descendants(doc.head).find(e=>e.tag==='style')!;expect(style.textContent).toContain('#18272B');expect(style.textContent).toContain('max-height:calc(100dvh - 32px)');expect(style.textContent).toContain('min-height:44px');expect(style.textContent).toContain('overflow-y:auto');expect(style.textContent).toContain('font-size:16px');
 });
});
