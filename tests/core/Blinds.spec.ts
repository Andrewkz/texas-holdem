import { describe, expect, it } from 'vitest';
import { DEFAULT_BLINDS, normalizeBlinds, validateBlinds, assertBlinds } from '../../assets/scripts/core/Blinds';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';

describe('blind configuration', () => {
  it('defaults to 20/40 and accepts arbitrary increasing integer blinds', () => {
    expect(DEFAULT_BLINDS).toEqual({smallBlind:20,bigBlind:40});
    for (const blinds of [{smallBlind:5,bigBlind:10},{smallBlind:50,bigBlind:100},{smallBlind:7,bigBlind:15},{smallBlind:999,bigBlind:1000}]) {
      expect(validateBlinds(blinds)).toBe(true);
      expect(normalizeBlinds(blinds)).toEqual(blinds);
      expect(normalizeBlinds(blinds)).not.toBe(blinds);
    }
  });
  it('rejects unsafe, fractional, reversed or missing blinds', () => {
    for(const value of [null,{},[],{smallBlind:0,bigBlind:40},{smallBlind:20,bigBlind:20},{smallBlind:41,bigBlind:40},{smallBlind:1,bigBlind:1001},{smallBlind:1.5,bigBlind:40},{smallBlind:1,bigBlind:Infinity},{smallBlind:"20",bigBlind:40},{smallBlind:1,bigBlind:Number.MAX_SAFE_INTEGER+1}]) {
      expect(validateBlinds(value)).toBe(false);
      expect(normalizeBlinds(value)).toEqual(DEFAULT_BLINDS);
      expect(()=>assertBlinds(value)).toThrow(RangeError);
      expect(()=>PokerEngine.createSixSeat({blinds:value as never})).toThrow(RangeError);
    }
  });
  it.each([{smallBlind:5,bigBlind:10},{smallBlind:50,bigBlind:100},{smallBlind:7,bigBlind:15}])('posts and uses configured blinds on every street: %j', blinds => {
    const game=PokerEngine.createSixSeat({blinds,random:()=>0.5});
    const started=game.startHand();
    expect(started.blinds).toEqual(blinds);
    expect(started.pot).toBe(blinds.smallBlind+blinds.bigBlind);
    expect(started.players.find(p=>p.id==='ai-3')?.streetContribution).toBe(blinds.smallBlind);
    expect(started.players.find(p=>p.id==='ai-4')?.streetContribution).toBe(blinds.bigBlind);
    expect(started.legalActions).toContainEqual({type:'raise',to:blinds.bigBlind*2});
    for(const street of ['preflop','flop','turn','river']) {
      if(street!=='preflop') expect(game.snapshot().legalActions).toContainEqual({type:'raise',to:blinds.bigBlind});
      while(game.snapshot().street===street) {
        const action=game.snapshot().legalActions.find(a=>a.type==='check')??game.snapshot().legalActions.find(a=>a.type==='call');
        game.act(action!);
      }
    }
    expect(game.snapshot().street).toBe('settled');
    expect(game.snapshot().players.reduce((s,p)=>s+p.stack,0)).toBe(30000);
  });
  it('copies constructor and snapshot configuration and retains it across hands', () => {
    const blinds={smallBlind:7,bigBlind:15};
    const game=PokerEngine.createSixSeat({blinds});
    blinds.smallBlind=100;blinds.bigBlind=200;
    const state=game.startHand();state.blinds!.smallBlind=500;
    expect(game.snapshot().blinds).toEqual({smallBlind:7,bigBlind:15});
    while(game.snapshot().street!=='settled')game.act({type:'fold'});
    expect(game.startHand().blinds).toEqual({smallBlind:7,bigBlind:15});
  });
  it('supports short blind all-ins without creating chips', () => {
    const game=PokerEngine.createWithPlayers([{id:'a',name:'A'},{id:'b',name:'B'}],{blinds:{smallBlind:50,bigBlind:100},stacks:{a:30,b:70},random:()=>0.5});
    const state=game.startHand();
    expect(state.street).toBe('settled');
    expect(state.players.reduce((s,p)=>s+p.stack,0)).toBe(100);
    expect(game.takeEvents().filter(e=>e.type==='blind-posted').map(e=>e.amount)).toEqual([30,70]);
  });
});
