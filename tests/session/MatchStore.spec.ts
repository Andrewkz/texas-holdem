import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryMatchStore } from '../../server/src/session/MemoryMatchStore';
import { FileMatchStore } from '../../server/src/session/FileMatchStore';
import { CommitPoint } from '../../server/src/session/MatchStore';

type RecordData = {sessionId:string; revision:number; value:{stack:number; buyIn:number}; receipt:string};
const first: RecordData = {sessionId:'session',revision:1,value:{stack:5000,buyIn:5000},receipt:'initial'};
const next: RecordData = {...first,revision:2,value:{stack:10000,buyIn:10000},receipt:'rebuy'};
const validate = (value: unknown):RecordData => {
  const r = value as RecordData;
  if (!r || typeof r.sessionId !== 'string' || !Number.isSafeInteger(r.revision) || !r.value || r.value.stack !== r.value.buyIn || !r.receipt) throw new Error('invalid aggregate');
  return r;
};
const directories:string[]=[];
function directory() { const d=mkdtempSync(join(realpathSync(tmpdir()),'poker-store-'));directories.push(d);return d; }
afterEach(() => { for(const d of directories.splice(0)) rmSync(d,{recursive:true,force:true}); });

for (const kind of ['memory','file']) describe(`${kind} aggregate store`, () => {
  function store() {return kind==='memory' ? new MemoryMatchStore<RecordData>() : new FileMatchStore(directory(),validate);}
  it('commits complete revisions with CAS and isolates all caller references', () => {
    const s=store(); const input=structuredClone(first);s.commit(input,0);input.value.stack=1;
    expect(s.loadAll()).toEqual([first]);
    const returned=s.loadAll(); returned[0].value.buyIn=1;
    expect(() => s.commit(next,0)).toThrowError(expect.objectContaining({code:'revision-conflict'}));
    expect(() => s.commit({...next,revision:3},1)).toThrow();
    expect(s.loadAll()).toEqual([first]);s.commit(next,1);expect(s.loadAll()).toEqual([next]);
  });
  it.each(['../outside','/absolute','a/b','..','a\\b',''])('rejects unsafe session ID %s', sessionId => {
    const s=store();expect(() => s.commit({...first,sessionId},0)).toThrow();expect(s.loadAll()).toEqual([]);
  });
  it('rejects invalid and unsafe revisions', () => {
    const s=store();
    for(const revision of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) expect(() => s.commit({...first,revision},0)).toThrow();
    expect(() => s.commit(first,-1)).toThrow();
  });
});

describe('MemoryMatchStore', () => {
  it('clones seed state and validates duplicate seed sessions', () => {
    const seed=structuredClone(first); const store=new MemoryMatchStore([seed]); seed.value.stack=1;
    expect(store.loadAll()).toEqual([first]);
    expect(() => new MemoryMatchStore([first, first])).toThrow();
  });
});

describe('FileMatchStore atomic boundaries', () => {
  it.each<CommitPoint>(['before-write','after-file-sync','after-rename','after-directory-sync'])('preserves a complete old or new aggregate when hook throws at %s', point => {
    const dir=directory();new FileMatchStore(dir,validate).commit(first,0);
    const seen:CommitPoint[]=[];
    const store=new FileMatchStore(dir,validate,{at(p,record){seen.push(p);expect(record).toEqual(next); if(p===point)throw new Error('injected crash boundary');}});
    expect(() => store.commit(next,1)).toThrow('injected crash boundary');
    const expected = point==='before-write'||point==='after-file-sync' ? first : next;
    expect(new FileMatchStore(dir,validate).loadAll()).toEqual([expected]);
    expect(store.loadAll()).toEqual([expected]);
    expect(seen.at(-1)).toBe(point);
  });
  it('exposes ordered durability barriers and leaves only a committed private JSON', () => {
    const dir=directory();const seen:CommitPoint[]=[];
    const store=new FileMatchStore(dir,validate,{at(p,record){seen.push(p);record.value.stack=999;}});
    store.commit(first,0);
    expect(seen).toEqual(['before-write','after-file-sync','after-rename','after-directory-sync']);
    expect(store.loadAll()).toEqual([first]);
    expect(statSync(dir).mode&0o777).toBe(0o700);
    const files=readdirSync(dir);expect(files).toHaveLength(1);
    expect(statSync(join(dir,files[0])).mode&0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir,files[0]),'utf8'))).toEqual(first);
  });
  it('ignores leftover temporary files but fails on corrupt committed JSON or failed validation', () => {
    const dir=directory();writeFileSync(join(dir,'.session.leftover.tmp'),'{half');
    expect(new FileMatchStore(dir,validate).loadAll()).toEqual([]);
    const store=new FileMatchStore(dir,validate);store.commit(first,0);
    const filename=readdirSync(dir).find(name=>name.endsWith('.json'))!;
    writeFileSync(join(dir,filename),'{broken');expect(()=>store.loadAll()).toThrowError(expect.objectContaining({code:'corrupt-record'}));
    writeFileSync(join(dir,filename),JSON.stringify({...first,value:{stack:1,buyIn:5000}}));expect(()=>store.loadAll()).toThrow();
  });
  it('rejects symlinks in the directory, directory ancestry and committed record', () => {
    const outer=directory();const data=join(outer,'data');const other=directory();symlinkSync(other,data);
    expect(()=>new FileMatchStore(data,validate)).toThrow();
    expect(()=>new FileMatchStore(join(data,'nested'),validate)).toThrow();
    const dir=directory();const store=new FileMatchStore(dir,validate);store.commit(first,0);
    const name=readdirSync(dir)[0];rmSync(join(dir,name));const target=join(other,'target');writeFileSync(target,JSON.stringify(first));symlinkSync(target,join(dir,name));
    expect(()=>store.loadAll()).toThrow();expect(()=>store.commit(next,1)).toThrow();
    expect(JSON.parse(readFileSync(target,'utf8'))).toEqual(first);
  });
  it('does not accept validator identity rewriting or mismatching committed filenames', () => {
    const dir=directory();const store=new FileMatchStore(dir,validate);store.commit(first,0);
    const name=readdirSync(dir)[0];writeFileSync(join(dir,name),JSON.stringify({...first,sessionId:'different'}));
    expect(()=>store.loadAll()).toThrow();
    expect(()=>new FileMatchStore(directory(),raw=>({...validate(raw),sessionId:'rewritten'})).commit(first,0)).toThrow();
  });
});
