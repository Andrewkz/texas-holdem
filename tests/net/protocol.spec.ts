import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage, PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
const identity = { sessionId: 's', tableEpoch: 'epoch' };
const admission = { nickname: 'Alice', requestId: 'request-1', token: 'a'.repeat(64) };
const session = { ...identity, lifecycle: 'active', checkpointVersion: 0, allOfflineDeadline: null };
const room = { code: 'AB23', phase: 'lobby', hostId: 'p1', seats: [], session };
describe('v4 wire contract', () => {
  it('accepts additive turn clocks and old packets while rejecting mismatched or corrupt clocks', () => {
    const snapshot={handId:1,street:'preflop',actingPlayerId:'p1',dealerPlayerId:'p1',pot:60,communityCards:[],legalActions:[{type:'check'}],players:[{id:'p1',name:'A',stack:4980,folded:false,allIn:false,streetContribution:20,totalContribution:20}]};
    const sync={type:'stateSync',...identity,snapshot,participation:'playing-hand'};
    const clock={playerId:'p1',deadlineAt:130000,serverNow:100000,durationMs:30000};
    expect(parseServerMessage(sync)).not.toBeNull();
    expect(parseServerMessage({...sync,turnTimer:clock})).not.toBeNull();
    expect(parseServerMessage({...sync,turnTimer:null})).not.toBeNull();
    for(const turnTimer of [false,[],{}, {...clock,playerId:'p2'}, {...clock,deadlineAt:NaN}, {...clock,deadlineAt:Infinity}, {...clock,deadlineAt:-1}, {...clock,serverNow:1.5}, {...clock,serverNow:Number.MAX_SAFE_INTEGER+1}, {...clock,durationMs:0}, {...clock,durationMs:-1}, {...clock,durationMs:'30000'}]) {
      expect(parseServerMessage({...sync,turnTimer})).toBeNull();
    }
    const settled={...sync,snapshot:{...snapshot,street:'settled',actingPlayerId:null,legalActions:[]}};
    expect(parseServerMessage({...settled,turnTimer:null})).not.toBeNull();
    expect(parseServerMessage({...settled,turnTimer:clock})).toBeNull();
    expect(parseServerMessage({...sync,snapshot:{...snapshot,actingPlayerId:null},turnTimer:clock})).toBeNull();
  });
  it('negotiates v4 and binds initial admission to caller generated proofs', () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(parseClientMessage({type:'createRoom',...admission})).toEqual({type:'createRoom',...admission});
    expect(parseClientMessage({type:'joinRoom',...admission,roomCode:'AB23',sessionId:'s'})).not.toBeNull();
    expect(parseClientMessage({type:'createRoom',nickname:'Alice'})).toBeNull();
    expect(parseClientMessage({type:'joinRoom',...admission,roomCode:'AB23'})).toBeNull();
    expect(parseClientMessage({type:'lookupRoom',roomCode:'AB23'})).not.toBeNull();
  });
  it('rejects unbound, fractional and caller selected rebuy amounts', () => {
    expect(parseClientMessage({type:'rebuy',sessionId:'s',requestId:'r',amount:999})).toBeNull();
    expect(parseClientMessage({type:'rebuy',sessionId:'s',requestId:'r'})).not.toBeNull();
    expect(parseClientMessage({type:'action',action:{type:'fold'}})).toBeNull();
    expect(parseClientMessage({type:'action',...identity,handId:1,action:{type:'fold'}})).not.toBeNull();
    expect(parseClientMessage({type:'action',...identity,handId:1,action:{type:'raise',to:1.5}})).toBeNull();
  });
  it('requires lifecycle and runtime authority on server state', () => {
    expect(parseServerMessage({type:'roomState',room})).not.toBeNull();
    expect(parseServerMessage({type:'roomState',room:{...room,session:{...session,lifecycle:'unknown'}}})).toBeNull();
    expect(parseServerMessage({type:'handStart',handId:1,dealerPlayerId:'p1',participantIds:['p1','p2']})).toBeNull();
    expect(parseServerMessage({type:'handStart',...identity,handId:1,dealerPlayerId:'p1',participantIds:['p1','p2']})).not.toBeNull();
  });
  it('validates ledger balances and final conservation', () => {
    const row={playerId:'p1',nickname:'A',seatStatus:'seated',totalBuyIn:5000,rebuyCount:0,stack:5000,releasedChips:0,pendingDepartureHandId:null,pendingRebuyRequestId:null};
    expect(parseServerMessage({type:'ledgerSync',ledger:{sessionId:'s',committedHandId:0,rows:[row]}})).not.toBeNull();
    for(const stack of [-1,1.5,Number.MAX_SAFE_INTEGER+1]) expect(parseServerMessage({type:'ledgerSync',ledger:{sessionId:'s',committedHandId:0,rows:[{...row,stack}]}})).toBeNull();
    const settlement={sessionId:'s',shareId:'public',endedAt:1,expiresAt:2592000001,reason:'host-ended',recoveryNotice:null,rows:[{playerId:'p1',nickname:'A',rebuyCount:0,totalBuyIn:5000,finalChips:5000,net:0}]};
    expect(parseServerMessage({type:'sessionEnded',settlement})).not.toBeNull();
    expect(parseServerMessage({type:'sessionEnded',settlement:{...settlement,rows:[{...settlement.rows[0],net:1}]}})).toBeNull();
  });
});

describe('v3 migrated first-phase parser regressions',()=>{
 it('trims names and permits every legal action variant with exact authority',()=>{
  expect(parseClientMessage({type:'createRoom',...admission,nickname:' Alice '})).toMatchObject({nickname:'Alice'});
  for(const action of [{type:'fold'},{type:'check'},{type:'all-in'},{type:'call',amount:40},{type:'raise',to:160}]){
    const raw={type:'action',...identity,handId:1,action};expect(parseClientMessage(raw)).toEqual(raw);
  }
  for(const type of ['leaveRoom','startGame','rebuy','requestEnd','commandStatus']){
    const raw=type==='startGame'?{type,sessionId:'s'}:{type,sessionId:'s',requestId:'r'};expect(parseClientMessage(raw)).toEqual(raw);
  }
  expect(parseClientMessage({type:'reconnect',sessionId:'s',token:'proof'})).not.toBeNull();
 });
 it('rejects corrupt or missing required business fields without accepting v2 messages',()=>{
  for(const raw of [null,'createRoom',[],{type:'nope'},
   {type:'createRoom',...admission,nickname:42},{type:'createRoom',...admission,nickname:' '},
   {type:'createRoom',...admission,nickname:'this-name-is-way-too-long'},
   {type:'joinRoom',...admission,sessionId:'s',roomCode:123},{type:'reconnect',sessionId:'s'},
   {type:'action',...identity,handId:1,action:{type:'call'}},{type:'action',...identity,handId:1,action:{type:'raise',to:'big'}},
   {type:'action',...identity,handId:1,action:{type:'surrender'}},{type:'action',...identity,handId:1},
   {type:'action',...identity,handId:1,action:{type:'call',amount:NaN}},
   {type:'action',...identity,handId:1,action:{type:'raise',to:-100}},
   {type:'action',...identity,handId:1,action:{type:'raise',to:Infinity}},
   {type:'action',...identity,handId:0,action:{type:'fold'}},
   {type:'createRoom',...admission,token:'short'},
  ])expect(parseClientMessage(raw)).toBeNull();
 });
 it('parses hello versions for explicit mismatch reporting and rejects unknown errors',()=>{
  expect(parseClientMessage({type:'hello',protocolVersion:2})).toEqual({type:'hello',protocolVersion:2});
  expect(parseServerMessage({type:'hello',protocolVersion:2})).toEqual({type:'hello',protocolVersion:2});
  expect(parseServerMessage({type:'hello',protocolVersion:'3'})).toBeNull();
  expect(parseServerMessage({type:'error',code:'invented',message:'bad'})).toBeNull();
 });
 it('requires actual participants, recipient participation and structurally valid snapshots',()=>{
  const start={type:'handStart',...identity,handId:1,dealerPlayerId:'p1',participantIds:['p1','p2']};
  expect(parseServerMessage(start)).not.toBeNull();
  expect(parseServerMessage({...start,participantIds:['p1',2]})).toBeNull();
  expect(parseServerMessage({...start,participantIds:['p1','p1']})).toBeNull();
  expect(parseServerMessage({...start,dealerPlayerId:'p3'})).toBeNull();
  const snapshot={handId:1,street:'preflop',actingPlayerId:'p1',dealerPlayerId:'p1',pot:60,communityCards:[],legalActions:[{type:'check'}],players:[{id:'p1',name:'A',stack:4980,folded:false,allIn:false,streetContribution:20,totalContribution:20}]};
  expect(parseServerMessage({type:'stateSync',...identity,snapshot})).toBeNull();
  expect(parseServerMessage({type:'stateSync',...identity,snapshot,participation:'playing-hand'})).not.toBeNull();
  expect(parseServerMessage({type:'stateSync',...identity,snapshot,participation:'waiting-next-hand'})).toBeNull();
  expect(parseServerMessage({type:'stateSync',...identity,snapshot:{...snapshot,legalActions:[]},participation:'waiting-next-hand'})).not.toBeNull();
  expect(parseServerMessage({type:'stateSync',...identity,snapshot:{...snapshot,players:[{id:'p1'}]},participation:'playing-hand'})).toBeNull();
  expect(parseServerMessage({type:'stateSync',...identity,snapshot:{...snapshot,legalActions:[{type:'raise',to:-1}]},participation:'playing-hand'})).toBeNull();
  expect(parseServerMessage({type:'yourHand',...identity,handId:1,cards:[{rank:20,suit:'S'}]})).toBeNull();
 });
});


describe('v4 blind amounts on the wire', () => {
  const blinds = { smallBlind: 75, bigBlind: 150 };
  it('preserves create settings and copies parsed values without allowing joiners to choose blinds', () => {
    const raw = { type: 'createRoom', ...admission, blinds: { ...blinds } };
    const parsed = parseClientMessage(raw);
    expect(parsed).toEqual(raw);
    raw.blinds.bigBlind = 200;
    expect((parsed as any).blinds).toEqual(blinds);
    expect(parseClientMessage({ type: 'joinRoom', ...admission, roomCode: 'AB23', sessionId: 's', blinds })).toBeNull();
    expect(parseServerMessage({ type: 'roomState', room: { ...room, blinds } })).not.toBeNull();
  });
  it.each([null, [], false, {}, { smallBlind: 0, bigBlind: 40 }, { smallBlind: 40, bigBlind: 40 }, { smallBlind: 41, bigBlind: 40 }, { smallBlind: 1.5, bigBlind: 40 }, { smallBlind: 20, bigBlind: 1001 }, { smallBlind: 20, bigBlind: Infinity }, { smallBlind: '20', bigBlind: 40 }])('rejects malformed blind values %j', blinds => {
    expect(parseClientMessage({ type: 'createRoom', ...admission, blinds })).toBeNull();
    expect(parseServerMessage({ type: 'roomState', room: { ...room, blinds } })).toBeNull();
    const snapshot = { handId: 1, street: 'preflop', actingPlayerId: 'p1', dealerPlayerId: 'p1', pot: 60, communityCards: [], legalActions: [], blinds, players: [{id:'p1',name:'A',stack:4980,folded:false,allIn:false,streetContribution:20,totalContribution:20}] };
    expect(parseServerMessage({ type: 'stateSync', ...identity, snapshot, participation: 'playing-hand' })).toBeNull();
  });
});
