import { PROTOCOL_VERSION } from '../../assets/scripts/net/protocol';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {NetClient,WebSocketLike} from '../../assets/scripts/net/NetClient';
import {OnlineCommands} from '../../assets/scripts/net/OnlineCommands';
function setup(){
 const sent:any[]=[];const socket:WebSocketLike={onopen:null,onmessage:null,onclose:null,onerror:null,send:raw=>sent.push(JSON.parse(raw)),close:()=>{}};
 const client=new NetClient('ws://test',()=>socket);const ready=client.connect();socket.onopen!();socket.onmessage!({data:JSON.stringify({type:'hello',protocolVersion: PROTOCOL_VERSION})});
 const emit=(message:any)=>socket.onmessage!({data:JSON.stringify(message)});
 return {client,socket,sent,ready,emit};
}
afterEach(()=>vi.useRealTimers());
describe('bounded idempotent commands',()=>{
 it('queries original ID after lost confirmation and retries unchanged payload',async()=>{
  vi.useFakeTimers();const t=setup();await t.ready;
  const commands=new OnlineCommands(t.client,'s',{timeoutMs:10});
  const pending=commands.execute('rebuy','original');await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject({requestId:'original',status:'pending'});
  const query=commands.query('original');expect(t.sent.at(-1)).toEqual({type:'commandStatus',sessionId:'s',requestId:'original'});
  t.emit({type:'commandResult',result:{sessionId:'s',requestId:'original',command:'rebuy',status:'committed'}});
  expect(await query).toMatchObject({status:'committed'});
  const retry=commands.retry('original');expect(t.sent.at(-1)).toEqual({type:'rebuy',sessionId:'s',requestId:'original'});
  t.emit({type:'commandResult',result:{sessionId:'s',requestId:'original',command:'rebuy',status:'committed'}});
  expect(await retry).toMatchObject({status:'committed'});t.client.close();commands.dispose();
 });
 it('bounds admission and accepts left identity or terminal ended without inventing a seat',async()=>{
  const t=setup();await t.ready;
  const pending=t.client.waitForAdmission(50);t.emit({type:'leftIdentity',sessionId:'s',playerId:'p1'});
  expect(await pending).toEqual({type:'leftIdentity',sessionId:'s',playerId:'p1'});t.client.close();
 });
 it('cancels waits and ignores late results without losing other subscribers',async()=>{
  const t=setup();await t.ready;const commands=new OnlineCommands(t.client,'s',{timeoutMs:20});
  const observed:any[]=[];t.client.onMessage=m=>observed.push(m);
  const pending=commands.execute('requestEnd','r');commands.dispose();
  expect(await pending).toMatchObject({status:'pending',requestId:'r'});
  t.emit({type:'commandResult',result:{sessionId:'s',requestId:'r',command:'requestEnd',status:'committed'}});
  expect(observed).toHaveLength(1);t.client.close();
 });
});

describe('v3 transport authority and cancellation',()=>{
 it('looks up the current session without ever sending a saved proof',async()=>{
  const t=setup();await t.ready;const lookup=t.client.lookupRoom('AB23',50);
  expect(t.sent.at(-1)).toEqual({type:'lookupRoom',roomCode:'AB23'});
  t.emit({type:'roomLookup',roomCode:'AB23',sessionId:'fresh'});expect(await lookup).toMatchObject({sessionId:'fresh'});t.client.close();
 });
 it('cancels admission on close and drops its late socket acknowledgement',async()=>{
  const t=setup();await t.ready;const observed:any[]=[];t.client.onMessage=m=>observed.push(m);
  const pending=t.client.waitForAdmission(20);const cancelled=expect(pending).rejects.toThrow('连接已取消');t.client.close();await cancelled;
  t.emit({type:'leftIdentity',sessionId:'s',playerId:'p1'});expect(observed).toHaveLength(0);
 });
 it('bounds lost admission separately from command uncertainty',async()=>{
  vi.useFakeTimers();const t=setup();await t.ready;const pending=t.client.waitForAdmission(10);
  const result=expect(pending).rejects.toThrow('服务器确认超时');await vi.advanceTimersByTimeAsync(10);await result;
  expect(await t.client.waitForAdmission(1).catch((error:Error)=>error.message)).toBe('连接尚未完成协议确认');
 });
});

describe('departed proof-only receipt query',()=>{
 it('queries a lost leave acknowledgement on a new transport without rejoining',async()=>{
  const t=setup();await t.ready;const commands=new OnlineCommands(t.client,'s',{token:'original-proof',timeoutMs:20});
  const result=commands.query('lost-leave','leaveRoom');
  expect(t.sent.at(-1)).toEqual({type:'commandStatus',sessionId:'s',requestId:'lost-leave',token:'original-proof'});
  t.emit({type:'commandResult',result:{sessionId:'s',requestId:'lost-leave',command:'leaveRoom',status:'committed'}});
  expect(await result).toMatchObject({status:'committed'});expect(t.sent.some(message=>message.type==='rejoin')).toBe(false);commands.dispose();t.client.close();
 });
});

describe('receipt query rejection',()=>{
 it('returns an explicit rejection for a missing original receipt without allocating a new ID',async()=>{
  const t=setup();await t.ready;const commands=new OnlineCommands(t.client,'s',{token:'proof',timeoutMs:20});
  const pending=commands.query('missing','leaveRoom');t.emit({type:'error',code:'command-not-found',message:'未找到原请求'});
  expect(await pending).toMatchObject({status:'rejected',requestId:'missing',code:'command-not-found'});expect(t.sent.at(-1).requestId).toBe('missing');commands.dispose();t.client.close();
 });
});

describe('receipt query after uncertain storage commit',()=>{
 it('preserves original request as unknown immediately when paused server cannot prove its receipt',async()=>{
  vi.useFakeTimers();const t=setup();await t.ready;
  const commands=new OnlineCommands(t.client,'s',{token:'original-proof',timeoutMs:10000});
  let observed:any=null;
  const pending=commands.query('end-before-rename','requestEnd').then(result=>{observed=result;return result;});
  t.emit({type:'error',code:'storage-failed',message:'存储提交状态待恢复确认'});
  await Promise.resolve();
  expect(observed).toMatchObject({sessionId:'s',requestId:'end-before-rename',command:'requestEnd',status:'pending',code:'confirmation-unknown'});
  expect(await pending).toEqual(observed);
  const queryAgain=commands.query('end-before-rename');
  expect(t.sent.at(-1)).toEqual({type:'commandStatus',sessionId:'s',requestId:'end-before-rename',token:'original-proof'});
  t.emit({type:'commandResult',result:{sessionId:'s',requestId:'end-before-rename',command:'requestEnd',status:'committed'}});
  expect(await queryAgain).toMatchObject({requestId:'end-before-rename',status:'committed'});
  expect(t.sent.some(message=>message.type==='requestEnd')).toBe(false);
  commands.dispose();t.client.close();
 });
});
