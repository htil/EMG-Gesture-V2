import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalPractice} from './practice-records.mjs';
const digest=payload=>crypto.createHash('sha256').update(canonicalPractice(payload)).digest('hex');
const checksum=(payload,committed)=>digest({payload,committed});
function atomic(file,value) {
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(`${file}.tmp`,`${JSON.stringify(value,null,2)}\n`);
 fs.renameSync(`${file}.tmp`,file);
}
// Intent precedes every materialized completion write. Atomic rename is not
// fsync/power-loss durability, and this journal assumes a single server writer.
export function readFinalization(file) {
 if(!fs.existsSync(file))return null;
 try {
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value.schemaVersion!==1 || typeof value.committed!=='boolean' || !value.payload || value.sha256!==checksum(value.payload,value.committed))throw new Error('Invalid journal');
  return value;
 } catch {throw Object.assign(new Error('Invalid or unreadable finalization journal; manual recovery required.'),{status:409});}
}
export function writeFinalization(file,payload) {
 const existing=readFinalization(file);
 if(existing) {
  if(digest(existing.payload)!==digest(payload))throw Object.assign(new Error('Finalization intent is immutable.'),{status:409});
  return existing;
 }
 const value={schemaVersion:1,committed:false,sha256:checksum(payload,false),payload};
 atomic(file,value);return value;
}
export function commitFinalization(file) {
 const value=readFinalization(file);
 if(!value)throw new Error('Missing finalization intent.');
 atomic(file,{...value,committed:true,sha256:checksum(value.payload,true)});
}
