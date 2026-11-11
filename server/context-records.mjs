import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const REASONS = new Set(['incomplete_center','incomplete_pre','incomplete_post','interrupted','capture_cancelled','source_gap','source_backwards','invalid_sample','invalid_or_discontinuous_source','scope_changed','recorder_scope_changed','disconnected','stopped','unmounted','source_reset','source_or_channel_changed']);
const check = (ok, message) => { if (!ok) throw new Error(`Invalid context: ${message}`); };
function keys(value, required, optional = []) {
 check(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
 check(Object.keys(value).every(k => [...required,...optional].includes(k)), 'unexpected key');
 check(required.every(k => Object.hasOwn(value,k)), 'missing key');
}
function id(value) { check(typeof value === 'string' && ID.test(value), 'invalid code'); }
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
/** Exact allowlist: no names/freeform metadata or silent extra-key acceptance. */
export function validateContextRecord(value) {
 keys(value,['schemaVersion','contextId','scope','attempt','sampleId','status','disposition','center','window','points','complete','reasons']);
 check(value.schemaVersion === 1,'schema'); id(value.contextId);
 keys(value.scope,['participantId','sessionId','condition','source','sourceEpoch','channel']);
 id(value.scope.participantId); id(value.scope.sessionId);
 check(['button','threshold'].includes(value.scope.condition),'condition');check(['mock','live'].includes(value.scope.source),'source');
 check(integer(value.scope.sourceEpoch) && integer(value.scope.channel),'source metadata');
 keys(value.attempt,['attemptId','gestureId','cueAt'],['retryOf']);id(value.attempt.attemptId);id(value.attempt.gestureId);
 check(value.contextId===value.attempt.attemptId,'context/attempt identity');check(finite(value.attempt.cueAt),'cue');if(value.attempt.retryOf!==undefined)id(value.attempt.retryOf);
 if(value.sampleId!==null)id(value.sampleId);
 check(['captured','failed','timeout','interrupted'].includes(value.status),'status');check(['retained','deleted','rejected'].includes(value.disposition),'disposition');
 keys(value.window,['startAt','endAt','preMs','postMs']);
 check(finite(value.window.startAt)&&finite(value.window.endAt)&&value.window.startAt<=value.window.endAt,'window');
 check(value.window.preMs===5000&&value.window.postMs===5000,'context durations');
 check(Array.isArray(value.points)&&value.points.length<=100000,'points');
 const ids=new Set();let last=-Infinity,lastId=-1;
 for(const p of value.points){
  keys(p,['time','raw','consumptionId']);check(finite(p.time)&&finite(p.raw)&&integer(p.consumptionId),'finite raw point');
  check(p.time>=last&&p.time>=value.window.startAt&&p.time<value.window.endAt,'source order/window');
  check(last===-Infinity || p.time-last<=500,'unmarked source gap');
  check(!ids.has(p.consumptionId)&&p.consumptionId>lastId,'consumption identity');ids.add(p.consumptionId);last=p.time;lastId=p.consumptionId;
 }
 check(typeof value.complete==='boolean'&&Array.isArray(value.reasons)&&value.reasons.every(r=>REASONS.has(r)),'completeness');
 check(value.complete===(value.reasons.length===0),'completeness reason');
 // Completeness is acquisition coverage under the declared <=500ms gap rule,
 // not a nominal sample count or proof of a physiological/device sample clock.
 if(value.complete) check(value.points.length>0
  && value.points[0].time-value.window.startAt<=500
  && value.window.endAt-value.points.at(-1).time<=500,'complete coverage');
 if(value.center!==null){
  const c=value.center;keys(c,['startAt','endAt','startIndex','endIndexExclusive','startConsumptionId']);
  check(finite(c.startAt)&&finite(c.endAt)&&c.endAt-c.startAt===2000,'exact 2 second center');
  check(integer(c.startIndex)&&integer(c.endIndexExclusive)&&c.startIndex<=c.endIndexExclusive&&c.endIndexExclusive<=value.points.length,'center index');
  check(integer(c.startConsumptionId),'center identity');
  const start=value.points.findIndex(p=>p.consumptionId===c.startConsumptionId);
  check(start<0?value.reasons.includes('incomplete_center'):start===c.startIndex&&value.points[start].time===c.startAt,'center anchor');
  const expectedEnd=value.points.findIndex((p,i)=>i>=c.startIndex&&p.time>=c.endAt);
  check(c.endIndexExclusive===(expectedEnd<0?value.points.length:expectedEnd),'center end index');
  check(value.window.startAt===c.startAt-5000,'pre boundary');
  if(value.status==='captured')check(value.window.endAt===c.endAt+5000,'post boundary');
 }else check(value.status!=='captured','captured requires center');
 return structuredClone(value);
}
const fingerprint = value => createHash('sha256').update(value).digest('hex');
function stable(value){ if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value; }
const recordPath=(directory,contextId)=>join(directory,`${fingerprint(contextId)}.context.json`);
/** Immutable idempotent write; caller must authorize scope and choose isolated storage. */
export async function persistContextRecord(directory, input) {
 const record=validateContextRecord(input);await mkdir(directory,{recursive:true});const path=recordPath(directory,record.contextId);
 // Publish a complete temporary file atomically without overwriting an existing record.
 const temporary=join(directory,`.${randomUUID()}.tmp`);await writeFile(temporary,JSON.stringify(record));
 const {link,unlink}=await import('node:fs/promises');
 try{await link(temporary,path);}catch(error){
  if(error.code!=='EEXIST')throw error;
  const existing=JSON.parse(await readFile(path,'utf8'));
  if(JSON.stringify(stable(existing))!==JSON.stringify(stable(record)))throw new Error('Context conflict');
 }finally{await unlink(temporary);}
 return record;
}
/** Disposition audit is append-only; raw record is never deleted or overwritten. */
const dispositionWrites = new Map();
async function readDispositionEvents(directory) {
 let files;try { files=await readdir(directory); } catch(error) { if(error.code==='ENOENT')return [];throw error; }
 const events=await Promise.all(files.filter(f=>f.endsWith('.disposition.json')).map(async f=>JSON.parse(await readFile(join(directory,f),'utf8'))));
 events.sort((a,b)=>a.at-b.at||a.eventId.localeCompare(b.eventId));
 return events;
}
export function setContextDisposition(directory, contextId, disposition) {
 id(contextId);check(['retained','deleted','rejected'].includes(disposition),'disposition');
 const key=recordPath(directory,contextId), previous=dispositionWrites.get(key)??Promise.resolve();
 const write=previous.catch(()=>{}).then(async()=>{
  await readFile(key,'utf8');
  const events=await readDispositionEvents(directory);
  const last=events.filter(e=>e.contextId===contextId).at(-1)?.at??0;
  // Logical ordering remains stable even for same-millisecond updates/restarts.
  const event={contextId,disposition,at:Math.max(Date.now(),last+1),eventId:randomUUID()};
  const target=join(directory,`${fingerprint(contextId)}.${event.at}.${event.eventId}.disposition.json`);
  const temporary=join(directory,`.${event.eventId}.tmp`);await writeFile(temporary,JSON.stringify(event));await rename(temporary,target);
  return event;
 }).finally(()=>{if(dispositionWrites.get(key)===write)dispositionWrites.delete(key);});
 dispositionWrites.set(key,write);return write;
}
export async function readContextRecords(directory) {
 let files;try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const records=await Promise.all(files.filter(f=>f.endsWith('.context.json')).sort().map(async f=>validateContextRecord(JSON.parse(await readFile(join(directory,f),'utf8')))));
 const events=await readDispositionEvents(directory);
 for(const r of records)for(const e of events)if(e.contextId===r.contextId)r.disposition=e.disposition;
 return records;
}
export async function exportContextRecords(directory) {
 const records=await readContextRecords(directory);
 const rows=['context_id,sample_id,index,region,consumption_id,time,raw'];
 for(const r of records)r.points.forEach((p,i)=>rows.push([r.contextId,r.sampleId??'',i,r.center&&i>=r.center.startIndex&&i<r.center.endIndexExclusive?'center':r.center&&i>=r.center.endIndexExclusive?'post':r.center?'pre':'context',p.consumptionId,p.time,p.raw].join(',')));
 return {json:JSON.stringify(records,null,2),csv:rows.join('\n')+'\n',dispositionJson:JSON.stringify(await readDispositionEvents(directory),null,2)};
}
