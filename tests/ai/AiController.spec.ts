import { describe, expect, it } from 'vitest';

import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import { chooseAiAction } from '../../assets/scripts/ai/AiController';
import { Card, PlayerAction, Suit } from '../../assets/scripts/core/types';

function card(rank: number, suit: Suit): Card {
  return { rank: rank as Card['rank'], suit };
}

function context(overrides: Partial<Parameters<typeof chooseAiAction>[0]> = {}) {
  return {
    holeCards: [card(2, 'C'), card(7, 'D')],
    communityCards: [],
    street: 'preflop' as const,
    pot: 60,
    toCall: 40,
    stack: 5000,
    legalActions: [{ type: 'fold' }, { type: 'call', amount: 40 }] as PlayerAction[],
    random: () => 0.1,
    ...overrides,
  };
}

describe('chooseAiAction', () => {
  it('does not raise when only fold and call are legal', () => {
    expect(chooseAiAction(context())).toEqual({ type: 'fold' });
  });

  it('uses a legal raise for a premium preflop pair', () => {
    expect(chooseAiAction(context({
      holeCards: [card(14, 'S'), card(14, 'H')],
      legalActions: [{ type: 'fold' }, { type: 'call', amount: 40 }, { type: 'raise', to: 120 }, { type: 'all-in' }],
    }))).toEqual({ type: 'raise', to: 120 });
  });

  it('can commit a premium short stack when all-in is the only non-fold action', () => {
    expect(chooseAiAction(context({
      holeCards: [card(14, 'S'), card(14, 'H')],
      stack: 25,
      legalActions: [{ type: 'fold' }, { type: 'all-in' }],
    }))).toEqual({ type: 'all-in' });
  });
});

describe('AI configured blind amounts', () => {
  it('scales preflop opening amounts with the configured big blind', () => {
    const getAction=(bigBlind:number) => chooseAiAction(context({
      holeCards:[card(14,'S'),card(14,'H')],bigBlind,pot:bigBlind*1.5,toCall:bigBlind,stack:bigBlind*125,
      legalActions:[{type:'fold'},{type:'call',amount:bigBlind},{type:'raise',to:bigBlind*2},{type:'all-in'}],
      random:()=>0.1,
    }));
    expect(getAction(10)).toEqual({type:'raise',to:20});
    expect(getAction(100)).toEqual({type:'raise',to:200});
    expect(getAction(40)).toEqual(chooseAiAction(context({holeCards:[card(14,'S'),card(14,'H')],bigBlind:Number.NaN, legalActions:[{type:'fold'},{type:'call',amount:40},{type:'raise',to:80},{type:'all-in'}],random:()=>0.1})));
  });
  it('uses legal integer sizes with small, large and odd custom blinds', () => {
    for(const bigBlind of [2,10,15,100,1000]) {
      for(let sample=0;sample<100;sample++) {
        const result=chooseAiAction(context({holeCards:[card(14,'S'),card(14,'H')],bigBlind,
          pot:bigBlind*1.5,toCall:bigBlind,stack:bigBlind*12+3,
          legalActions:[{type:'fold'},{type:'call',amount:bigBlind},{type:'raise',to:bigBlind*2},{type:'all-in'}],random:()=>sample/100,
        }));
        if(result.type==='raise') {
          expect(Number.isInteger(result.to)).toBe(true);
          expect(result.to).toBeGreaterThanOrEqual(bigBlind*2);
          expect(result.to).toBeLessThanOrEqual(bigBlind*12+3);
        }
      }
    }
  });
});

it('plays complete hands legally and conserves stacks at configured blind levels', () => {
  let seed=173;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(const blinds of [{smallBlind:1,bigBlind:2},{smallBlind:7,bigBlind:15},{smallBlind:50,bigBlind:100},{smallBlind:999,bigBlind:1000}]) {
    for(let hand=0;hand<16;hand++) {
      const game=PokerEngine.createSixSeat({blinds,random});game.startHand();let actions=0;
      while(game.snapshot().street!=='settled') {
        const state=game.snapshot(),actor=state.players.find(p=>p.id===state.actingPlayerId)!;
        const toCall=Math.max(...state.players.map(p=>p.streetContribution))-actor.streetContribution;
        const action=chooseAiAction({holeCards:game.getHoleCards(actor.id),communityCards:state.communityCards,
          street:state.street,pot:state.pot,toCall,stack:actor.stack,streetContribution:actor.streetContribution,
          bigBlind:state.blinds!.bigBlind,playersInHand:state.players.filter(p=>!p.folded).length,legalActions:state.legalActions,random});
        expect(()=>game.act(action)).not.toThrow();
        expect(++actions).toBeLessThan(300);
        expect(game.snapshot().players.every(p=>Number.isSafeInteger(p.stack)&&p.stack>=0)).toBe(true);
      }
      expect(game.snapshot().players.reduce((sum,p)=>sum+p.stack,0)).toBe(30000);
    }
  }
});
