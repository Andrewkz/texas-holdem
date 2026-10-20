import { DEFAULT_BLINDS } from '../core/Blinds';
import { Card, PlayerAction, Street } from '../core/types';
import { assessVisibleHand } from './AiHandStrength';
import { AiProfile, DEFAULT_AI_PROFILE } from './AiPersonality';

export interface AiContext {
  holeCards: readonly Card[];
  communityCards: readonly Card[];
  street: Street;
  pot: number;
  /** Full public gap, including when the stack cannot afford a normal call. */
  toCall: number;
  stack: number;
  bigBlind?: number;
  streetContribution?: number;
  playersInHand?: number;
  /** Public action order: 0 early, 1 late. */
  position?: number;
  profile?: AiProfile;
  legalActions: readonly PlayerAction[];
  random: () => number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
function unit(random: () => number): number { const n=random(); return Number.isFinite(n) ? clamp(n,0,1-Number.EPSILON) : 0.5; }

/** Public-information heuristics with mixed actions; strength scores are not claimed win probabilities. */
export function chooseAiAction(context: AiContext): PlayerAction {
  if (!context.legalActions.length) throw new RangeError('AI needs at least one legal action');
  const byType = new Map(context.legalActions.map(a => [a.type,a]));
  const fold=byType.get('fold'), check=byType.get('check'), call=byType.get('call'), raise=byType.get('raise'), allIn=byType.get('all-in');
  const hand=assessVisibleHand(context.holeCards,context.communityCards,context.street);
  if (hand.sharedNuts) return check ?? call ?? allIn ?? fold ?? context.legalActions[0];
  if (context.legalActions.length===1) return context.legalActions[0];
  const p=context.profile ?? DEFAULT_AI_PROFILE;
  const players=clamp(context.playersInHand ?? 2,2,6);
  const late=clamp(context.position ?? 0.5,0,1);
  const paid=Math.min(Math.max(0,context.toCall),context.stack);
  const odds=paid/Math.max(1,context.pot+paid);
  const stackRisk=paid/Math.max(1,context.stack);
  const quality=clamp(hand.madeStrength+hand.drawPotential*0.75+(p.looseness-0.5)*0.14-(players-2)*0.022+(late-0.5)*0.05,0.03,0.99);
  const pressure=clamp(odds*1.4+stackRisk*0.22,0,0.98);
  let foldRate=check?0:clamp((pressure+0.18-quality)*1.35+(0.5-p.looseness)*0.12,0.015,0.97);
  if (!check&&quality<0.25&&stackRisk>0.6) foldRate=Math.max(foldRate,0.985);
  if (hand.madeStrength >= 0.94 && !hand.boardOnly) foldRate = 0;
  const opportunity=(quality<0.43?(check?1:(odds<0.22?0.5:0.12)):0.12)/Math.sqrt(players-1);
  let raiseRate=raise?.type==='raise'?clamp(0.02+Math.max(0,quality-0.4)*(0.6+p.aggression)+p.bluffFrequency*opportunity+hand.drawPotential*0.2,0.01,0.85):0;
  if (pressure>0.55&&quality<0.72) raiseRate*=0.16;
  if (hand.boardOnly) raiseRate=Math.min(raiseRate,0.015);
  const short=context.stack<=Math.max(bigBlind(context)*4,context.pot*1.6+context.toCall);
  let shoveRate=allIn?(!check&&!call&&!raise?1-foldRate:(quality>0.8&&short?0.06+(quality-0.8)*1.1:quality>0.88?0.006*p.aggression:0)):0;
  const aggressiveBudget=Math.max(0,1-foldRate)*0.92;
  if (raiseRate + shoveRate > aggressiveBudget && (check || call)) {
    const scale=aggressiveBudget/Math.max(0.001,raiseRate+shoveRate);raiseRate*=scale;shoveRate*=scale;
  }
  const options:Array<{action:PlayerAction;weight:number}>=[];
  if(fold)options.push({action:fold,weight:foldRate});
  if(raise?.type==='raise')options.push({action:raise,weight:raiseRate});
  if(allIn)options.push({action:allIn,weight:shoveRate});
  const passive=check??call;
  if(passive)options.push({action:passive,weight:Math.max(0,1-foldRate-raiseRate-shoveRate)});
  const total=options.reduce((sum,x)=>sum+x.weight,0);
  if(total<=0)return passive??fold??allIn??context.legalActions[0];
  let roll=unit(context.random)*total;
  let chosen=options[options.length-1].action;
  for(const option of options){roll-=option.weight;if(roll<0){chosen=option.action;break;}}
  return chosen.type==='raise'?sizeRaise(context,chosen,p,allIn):chosen;
}

function sizeRaise(context:AiContext,minimum:Extract<PlayerAction,{type:'raise'}>,profile:AiProfile,allIn:PlayerAction|undefined):PlayerAction {
  const bb=bigBlind(context);
  const contribution=context.streetContribution??0;
  const maximum=contribution+context.stack;
  const minTo=Math.ceil(minimum.to);
  if(maximum<minTo)return context.legalActions.find(a=>a.type==='call'||a.type==='check')??allIn??context.legalActions[0];
  const currentBet=contribution+Math.max(0,context.toCall);
  const pick=unit(context.random);
  let target:number;
  if(context.street==='preflop'){
    const open=[2,2.5,3,3.5,4,5];
    const reraises=[2.1,2.5,2.8,3.2,3.8];
    const sizes=currentBet<=bb*2?open:reraises;
    const index=Math.min(sizes.length-1,Math.floor(clamp(pick+(profile.aggression-0.5)*0.15,0,0.9999)*sizes.length));
    target=sizes[index]*(currentBet<=bb*2?bb:currentBet);
  }else{
    const fractions=[0.25,0.33,0.5,0.67,0.75,1,1.25];
    const index=Math.min(fractions.length-1,Math.floor(clamp(pick+(profile.aggression-0.5)*0.2,0,0.9999)*fractions.length));
    target=currentBet+fractions[index]*(context.pot+Math.min(context.toCall,context.stack));
  }
  target*=1+(unit(context.random)-0.5)*profile.sizingVariance*0.4;
  const step=profile.sizingVariance>0.75&&unit(context.random)<0.18?Math.max(1,Math.floor(bb/8)):Math.max(1,Math.floor(bb/2));
  const to=clamp(Math.round(target/step)*step,minTo,maximum);
  return to===maximum&&allIn?allIn:{type:'raise',to};
}

function bigBlind(context: AiContext): number {
  return Number.isSafeInteger(context.bigBlind) && context.bigBlind! >= 2 && context.bigBlind! <= 1000
    ? context.bigBlind! : DEFAULT_BLINDS.bigBlind;
}
