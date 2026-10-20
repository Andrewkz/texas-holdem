import { describe, expect, it } from 'vitest';
import { chooseAiAction, type AiContext } from '../../assets/scripts/ai/AiController';
import { createAiTableProfiles, DEFAULT_AI_PROFILE } from '../../assets/scripts/ai/AiPersonality';
import { PokerEngine } from '../../assets/scripts/core/PokerEngine';
import type { Card, PlayerAction } from '../../assets/scripts/core/types';
function rng(seed: number) { let s=seed>>>0; return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;}; }
const c=(rank:number,suit:Card['suit']):Card=>({rank:rank as Card['rank'],suit});
const base=(overrides:Partial<AiContext>={}):AiContext=>({holeCards:[c(12,'S'),c(11,'H')],communityCards:[],street:'preflop',pot:300,toCall:40,stack:5000,streetContribution:0,legalActions:[{type:'fold'},{type:'call',amount:40},{type:'raise',to:80},{type:'all-in'}],random:rng(77),...overrides});
const sample=(context:AiContext,n=1500)=>Array.from({length:n},()=>chooseAiAction(context));
const count=(actions:PlayerAction[],type:PlayerAction['type'])=>actions.filter(a=>a.type===type).length;
describe('human-like solo decisions',()=>{
 it('mixes actions and more than minimum raise sizes reproducibly from the same visible situation',()=>{
  const setup=()=>base({holeCards:[c(14,'S'),c(14,'H')],communityCards:[c(14,'D'),c(7,'C'),c(2,'H')],street:'flop',pot:1200,toCall:0,legalActions:[{type:'fold'},{type:'check'},{type:'raise',to:40},{type:'all-in'}],random:rng(134)});
  const a=sample(setup(),1000);expect(a).toEqual(sample(setup(),1000));expect(new Set(a.map(x=>x.type)).size).toBeGreaterThanOrEqual(2);const raises=a.filter((x):x is Extract<PlayerAction,{type:'raise'}>=>x.type==='raise');expect(raises.length).toBeGreaterThan(200);expect(new Set(raises.map(x=>x.to)).size).toBeGreaterThanOrEqual(4);expect(raises.every(x=>Number.isSafeInteger(x.to)&&x.to>=40&&x.to<=5000)).toBe(true);
 });
 it('folds weak cards much more often at a large price while always taking a free check over folding',()=>{
  const weak=[c(7,'C'),c(2,'D')];const cheap=sample(base({holeCards:weak,pot:1000,toCall:20,legalActions:[{type:'fold'},{type:'call',amount:20}],random:rng(2)}));const costly=sample(base({holeCards:weak,pot:400,toCall:3500,legalActions:[{type:'fold'},{type:'call',amount:3500}],random:rng(2)}));expect(count(costly,'fold')).toBeGreaterThan(count(cheap,'fold')+500);
  expect(sample(base({holeCards:weak,toCall:0,legalActions:[{type:'fold'},{type:'check'}]}),100).every(x=>x.type==='check')).toBe(true);
 });
 it('keeps aggressive and conservative opponents observably different without always choosing one action',()=>{
  const profiles=[...createAiTableProfiles(['a','b','c','d','e'],rng(8)).values()];const tight=profiles.find(p=>p.style==='tight')!,aggressive=profiles.find(p=>p.style==='aggressive')!;const make=(profile:typeof tight)=>base({profile,random:rng(9),holeCards:[c(13,'S'),c(12,'S')],pot:300,toCall:0,legalActions:[{type:'fold'},{type:'check'},{type:'raise',to:40},{type:'all-in'}]});const a=sample(make(aggressive)),t=sample(make(tight));expect(count(a,'raise')).toBeGreaterThan(count(t,'raise')+150);expect(count(t,'check')).toBeGreaterThan(100);expect(count(a,'check')).toBeGreaterThan(50);
 });
 it('does not force a short-stack trash hand all-in merely because calling is unavailable',()=>{
  const actions=sample(base({holeCards:[c(7,'C'),c(2,'D')],toCall:300,stack:25,pot:40,legalActions:[{type:'fold'},{type:'all-in'}],random:rng(44)}),300);expect(count(actions,'fold')).toBeGreaterThan(250);
 });
 it('never folds a private straight flush or raises a shared royal board',()=>{
  const royal=base({holeCards:[c(14,'S'),c(13,'S')],communityCards:[c(12,'S'),c(11,'S'),c(10,'S'),c(2,'D'),c(3,'C')],street:'river',pot:5000,toCall:5000,stack:5000,legalActions:[{type:'fold'},{type:'call',amount:5000}],random:()=>0});expect(chooseAiAction(royal).type).toBe('call');
  const shared=base({holeCards:[c(2,'C'),c(7,'D')],communityCards:[c(14,'S'),c(13,'S'),c(12,'S'),c(11,'S'),c(10,'S')],street:'river',random:()=>0});expect(chooseAiAction(shared).type).toBe('call');
 });
 it('uses total street contribution for maximumTo and never invents illegal odd-stack targets',()=>{
  for(const value of [0,0.1,0.3,0.5,0.9,1,NaN,-3,Infinity]){const a=chooseAiAction(base({holeCards:[c(14,'S'),c(14,'H')],streetContribution:80,stack:137,pot:220,toCall:40,legalActions:[{type:'fold'},{type:'call',amount:40},{type:'raise',to:180},{type:'all-in'}],random:()=>value}));if(a.type==='raise'){expect(a.to).toBeGreaterThanOrEqual(180);expect(a.to).toBeLessThanOrEqual(217);expect(Number.isSafeInteger(a.to)).toBe(true);}else expect(['fold','call','all-in']).toContain(a.type);}
 });
 it('plays hundreds of seeded engine hands legally, terminates and conserves chips',()=>{
  let actions=0;const amounts=new Set<number>();const kinds=new Set<string>();
  for(let seed=1;seed<=160;seed++){const ids=['a','b','c','d','e','f'];const profiles=createAiTableProfiles(ids,rng(seed+500));const random=rng(seed+900);const game=PokerEngine.createWithPlayers(ids.map(id=>({id,name:id})),{random:rng(seed),stacks:Object.fromEntries(ids.map(id=>[id,seed%3===0?337:5000]))});game.startHand();for(let step=0;step<220&&game.snapshot().street!=='settled';step++){const s=game.snapshot(),actor=s.players.find(p=>p.id===s.actingPlayerId)!;const toCall=Math.max(...s.players.map(p=>p.streetContribution))-actor.streetContribution;const a=chooseAiAction(base({holeCards:game.getHoleCards(actor.id),communityCards:s.communityCards,street:s.street,pot:s.pot,toCall,stack:actor.stack,streetContribution:actor.streetContribution,playersInHand:s.players.filter(p=>!p.folded).length,legalActions:s.legalActions,profile:profiles.get(actor.id)??DEFAULT_AI_PROFILE,random}));expect(()=>game.act(a)).not.toThrow();kinds.add(a.type);if(a.type==='raise')amounts.add(a.to);actions++;}expect(game.snapshot().street).toBe('settled');expect(game.snapshot().players.reduce((sum,p)=>sum+p.stack,0)).toBe(ids.length*(seed%3===0?337:5000));}
  expect(actions).toBeGreaterThan(1000);expect(amounts.size).toBeGreaterThan(15);expect(kinds.has('raise')&&kinds.has('fold')&&kinds.has('call')&&kinds.has('check')).toBe(true);
 });
});
