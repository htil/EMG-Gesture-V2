import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url).pathname;
const out=process.env.EMG_BATCH_EVIDENCE_DIR || '/workspace/EMG-Backend-Batch-Validation-20261108/implementation/verified';
fs.mkdirSync(out,{recursive:true});
const cases=['checkpoint-active-rejected','checkpoint-finalization-rejected','collection-rejected','partial-ACK','delayed-ACK'];
const results=[];
for(const fault of cases){
 const result=spawnSync(process.execPath,['--test','tests/third-capture-matrix.test.mjs'],{cwd:root,env:{...process.env,EMG_BATCH_EVIDENCE_DIR:out,TEST_FAULT:fault},encoding:'utf8'});
 fs.writeFileSync(path.join(out,fault+'.tap'),result.stdout+result.stderr);
 try{assert.equal(result.status,0);const d=JSON.parse(fs.readFileSync(path.join(out,fault+'.json')));assert.equal(d.results.length,1);const r=d.results[0];assert.equal(r.status,'PASS');assert.ok(r.checks.length>=8);assert.ok(r.checks.every(c=>c.status==='PASS'));results.push({fault,status:'PASS',assertions:r.checks.length});}
 catch(error){results.push({fault,status:'FAIL',exit:result.status,error:error.message});}
}
fs.writeFileSync(path.join(out,'runner-results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.length!==cases.length||results.some(r=>r.status!=='PASS'))process.exitCode=1;
