import { describe, expect, it } from 'vitest';
import { chooseEntryIntent } from '../../assets/scripts/net/OnlineEntry';
const stored={roomCode:'AB23',sessionId:'s1',playerId:'p1',autoResume:true,token:'proof',nickname:'A',serverUrl:'wss://example.test/ws'};
describe('lookup-bound entry',()=>{
 it('never sends a saved proof from a room code alone',()=>{
   expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},stored,stored.serverUrl)).toEqual({kind:'lookup',roomCode:'AB23'});
 });
 it('matches full endpoint and stable session after lookup',()=>{
   expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},stored,stored.serverUrl,'s1')).toEqual({kind:'resume',credentials:stored});
   expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},stored,stored.serverUrl,'s2')).toEqual({kind:'join',roomCode:'AB23',sessionId:'s2'});
   expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},stored,'wss://other.test/ws','s1')).toEqual({kind:'join',roomCode:'AB23',sessionId:'s1'});
 });
 it('offers explicit rejoin for deactivated proof and explains legacy credentials',()=>{
   const left={...stored,autoResume:false};
   expect(chooseEntryIntent({kind:'none'},left,stored.serverUrl)).toEqual({kind:'rejoin',credentials:left});
   const {sessionId,playerId,...legacy}=stored;
   expect(chooseEntryIntent({kind:'none'},legacy,stored.serverUrl)).toMatchObject({kind:'legacy-unavailable'});
 });
 it('does not reinterpret invalid invites',()=>{
   expect(chooseEntryIntent({kind:'invalid',message:'bad'},stored,stored.serverUrl)).toEqual({kind:'invalid',message:'bad'});
 });
});

describe('v3 migrated endpoint and invitation regressions',()=>{
 it.each(['wss://other.test/ws','ws://example.test/ws','wss://example.test:8443/ws','wss://example.test/other','wss://example.test/ws?game=other','invalid'])('never matches the proof for different complete endpoint %s',target=>{
  expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},stored,target,'s1')).toEqual({kind:'join',roomCode:'AB23',sessionId:'s1'});
  expect(chooseEntryIntent({kind:'none'},stored,target)).toEqual({kind:'setup'});
 });
 it('recognizes equivalent full endpoints with default ports and sorted query keys',()=>{
  const credentials={...stored,serverUrl:'wss://EXAMPLE.test:443/ws?b=2&a=1'};
  expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},credentials,'wss://example.test/ws?a=1&b=2','s1')).toEqual({kind:'resume',credentials});
 });
 it('offers an ordinary setup or explicit join without a usable proof',()=>{
  expect(chooseEntryIntent({kind:'none'},null,stored.serverUrl)).toEqual({kind:'setup'});
  for(const credentials of [null,{...stored,token:''},{...stored,token:'  '},{...stored,roomCode:'AB0O'}]){
   expect(chooseEntryIntent({kind:'none'},credentials,stored.serverUrl)).toEqual({kind:'setup'});
   expect(chooseEntryIntent({kind:'valid',roomCode:'AB23'},credentials,stored.serverUrl,'s1')).toEqual({kind:'join',roomCode:'AB23',sessionId:'s1'});
  }
 });
});
