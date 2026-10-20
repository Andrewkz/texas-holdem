import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({play:vi.fn(),load:vi.fn()}));
vi.mock('cc',()=>({AudioClip:class{},AudioSource:class{playOneShot=fake.play},Node:class{},resources:{load:fake.load}}));
import { GameAudio } from '../../assets/scripts/ui/GameAudio';
import { DEFAULT_GAME_SETTINGS } from '../../assets/scripts/ui/GameSettings';
let listeners:Map<string,Function>;
let doc:{visibilityState:string;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  fake.play.mockReset();fake.load.mockReset().mockImplementation((path,_type,cb)=>cb(null,{path}));listeners=new Map();
  doc={visibilityState:'visible',addEventListener:vi.fn((name,fn)=>listeners.set(name,fn)),removeEventListener:vi.fn()};vi.stubGlobal('document',doc);
});
afterEach(()=>vi.unstubAllGlobals());
function make(getSettings:()=>any=()=>({...DEFAULT_GAME_SETTINGS})){return new GameAudio({addComponent:()=>({playOneShot:fake.play})} as any,getSettings)}
describe('game audio browser safety',()=>{
  it('drops events before a trusted gesture instead of queuing them',async()=>{
    const audio=make();await audio.preload();audio.play('turn');expect(fake.play).not.toHaveBeenCalled();
    listeners.get('pointerup')?.({isTrusted:false});audio.play('turn');expect(fake.play).not.toHaveBeenCalled();
    listeners.get('pointerup')?.({isTrusted:true});fake.play.mockClear();audio.play('turn');
    expect(fake.play).toHaveBeenCalledOnce();expect(fake.play.mock.calls[0][0].path).toBe('audio/turn');
    audio.destroy();expect(doc.removeEventListener).toHaveBeenCalled();
  });
  it('warms Cocos only once across duplicate browser gesture events',async()=>{
    const audio=make();await audio.preload();listeners.get('pointerup')?.({isTrusted:true});listeners.get('mouseup')?.({isTrusted:true});audio.unlockFromGesture();
    expect(fake.play).toHaveBeenCalledOnce();expect(fake.play.mock.calls[0][1]).toBe(0);audio.destroy();
  });
  it('scales fresh preferences, skips hidden audio, and has no late preload replay',async()=>{
    let settings={...DEFAULT_GAME_SETTINGS,soundVolume:0.5};const audio=make(()=>settings);audio.unlockFromGesture();audio.play('card');
    await audio.preload();expect(fake.play).not.toHaveBeenCalled();audio.play('chip');expect(fake.play.mock.calls[0][1]).toBe(0.275);
    settings={...settings,soundEnabled:false};audio.play('card');expect(fake.play).toHaveBeenCalledOnce();
    settings={...settings,soundEnabled:true,actionAlertsEnabled:false};audio.play('turn-warning');expect(fake.play).toHaveBeenCalledOnce();
    doc.visibilityState='hidden';audio.play('card');expect(fake.play).toHaveBeenCalledOnce();audio.destroy();
  });
  it('keeps available clips when one resource fails and supports the old boolean getter',async()=>{
    fake.load.mockImplementation((path,_type,cb)=>path==='audio/card'?cb(new Error('missing')):cb(null,{path}));
    let enabled=true;const audio=make(()=>enabled);await expect(audio.preload()).resolves.toBeUndefined();audio.unlockFromGesture();fake.play.mockClear();
    audio.play('card');audio.play('chip');expect(fake.play).toHaveBeenCalledOnce();enabled=false;audio.play('chip');expect(fake.play).toHaveBeenCalledOnce();
    audio.destroy();audio.play('chip');expect(fake.play).toHaveBeenCalledOnce();
  });
});
