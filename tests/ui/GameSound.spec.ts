import { describe, expect, it } from 'vitest';

import { GAME_SOUND_EVENTS, resolveGameSound, resolveSoundPlayback, TurnSoundGate } from '../../assets/scripts/ui/GameSound';

describe('game sound gate', () => {
  it('passes every supported semantic event when sound is enabled', () => {
    expect(GAME_SOUND_EVENTS).toEqual(['ui-click', 'card', 'chip', 'settlement', 'check', 'fold', 'turn', 'turn-warning']);
    for (const event of GAME_SOUND_EVENTS) {
      expect(resolveGameSound(event, true)).toBe(event);
    }
  });

  it('suppresses every event when sound is disabled', () => {
    for (const event of GAME_SOUND_EVENTS) {
      expect(resolveGameSound(event, false)).toBeNull();
    }
  });
});

describe('semantic sound playback',()=>{
  const settings={soundEnabled:true,soundVolume:0.5,actionAlertsEnabled:true};
  it('scales every sound and independently gates only action alerts',()=>{
    expect(resolveSoundPlayback('chip',settings)).toEqual({event:'chip',volume:0.275});
    expect(resolveSoundPlayback('turn',{...settings,actionAlertsEnabled:false})).toBeNull();
    expect(resolveSoundPlayback('chip',{...settings,actionAlertsEnabled:false})).not.toBeNull();
    for(const event of GAME_SOUND_EVENTS){expect(resolveSoundPlayback(event,{...settings,soundEnabled:false})).toBeNull();expect(resolveSoundPlayback(event,{...settings,soundVolume:0})).toBeNull();}
  });
});
describe('own-turn sound boundaries',()=>{
  const own={turnKey:'epoch:1:a:30000',isOwnTurn:true,seconds:30,canAlert:true};
  it('plays once at own start and once at five seconds despite repeats and reconnect',()=>{
    const gate=new TurnSoundGate();expect(gate.read(own)).toBe('turn');expect(gate.read(own)).toBeNull();
    expect(gate.read({...own,seconds:6})).toBeNull();expect(gate.read({...own,seconds:5})).toBe('turn-warning');expect(gate.read({...own,seconds:4})).toBeNull();
    expect(gate.read({...own,turnKey:null,isOwnTurn:false})).toBeNull();expect(gate.read({...own,seconds:4})).toBeNull();
  });
  it('does not alert for opponents, expired turns, hidden or muted boundaries',()=>{
    const gate=new TurnSoundGate();expect(gate.read({...own,isOwnTurn:false})).toBeNull();
    expect(gate.read({...own,canAlert:false})).toBeNull();expect(gate.read(own)).toBeNull();
    expect(gate.read({...own,seconds:5,canAlert:false})).toBeNull();expect(gate.read({...own,seconds:5})).toBeNull();
    expect(gate.read({...own,turnKey:'expired',seconds:0})).toBeNull();
  });
  it('recognizes another turn of the same player and collapses a late initial warning',()=>{
    const gate=new TurnSoundGate();gate.read(own);
    expect(gate.read({...own,turnKey:'epoch:1:a:60000'})).toBe('turn');
    expect(gate.read({...own,turnKey:'epoch:1:a:90000',seconds:4})).toBe('turn-warning');
    expect(gate.read({...own,turnKey:'epoch:1:a:90000',seconds:3})).toBeNull();
  });
});
