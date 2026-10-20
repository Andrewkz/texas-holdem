import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GAME_SOUND_EVENTS } from '../../assets/scripts/ui/GameSound';

describe('short original poker sound resources',()=>{
 it('provides distinct uncompressed clips with safe levels and unique Cocos metadata',()=>{
  const hashes=new Set<string>();const uuids=new Set<string>();
  for(const event of GAME_SOUND_EVENTS){
   const path=new URL(`../../assets/resources/audio/${event}.wav`,import.meta.url);const bytes=readFileSync(path);
   expect(bytes.toString('ascii',0,4)).toBe('RIFF');expect(bytes.toString('ascii',8,12)).toBe('WAVE');
   expect(bytes.readUInt16LE(20)).toBe(1);expect(bytes.readUInt16LE(22)).toBe(1);expect(bytes.readUInt32LE(24)).toBe(44100);expect(bytes.readUInt16LE(34)).toBe(16);
   let dataOffset=12;while(bytes.toString('ascii',dataOffset,dataOffset+4)!=='data')dataOffset+=8+bytes.readUInt32LE(dataOffset+4);
   const count=bytes.readUInt32LE(dataOffset+4)/2;const duration=count/44100;let sum=0,squares=0,peak=0;
   for(let index=0;index<count;index++){const sample=bytes.readInt16LE(dataOffset+8+index*2)/32768;sum+=sample;squares+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
   expect(duration).toBeGreaterThanOrEqual(0.05);expect(duration).toBeLessThanOrEqual(0.5);expect(Math.abs(sum/count)).toBeLessThan(0.01);expect(Math.sqrt(squares/count)).toBeGreaterThan(0.015);expect(Math.sqrt(squares/count)).toBeLessThan(0.25);expect(peak).toBeLessThan(0.9);
   hashes.add(createHash('sha256').update(bytes).digest('hex'));
   const meta=JSON.parse(readFileSync(new URL(`${path.href}.meta`),'utf8'));expect(meta.importer).toBe('audio-clip');uuids.add(meta.uuid);
  }
  expect(hashes.size).toBe(GAME_SOUND_EVENTS.length);expect(uuids.size).toBe(GAME_SOUND_EVENTS.length);
 });
});
