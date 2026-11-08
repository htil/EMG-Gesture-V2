import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/practice-fixture.mjs';
import { restCalibration } from '../src/app/study/frozenCalibration.mjs';
test('recalibration after a channel change preserves the rehearsal attempt',async t=>{
 const f=await fixture(t),rest={...f.record,flowVersion:2};rest.calibration=restCalibration(rest);
 const next={...rest,id:'rest-new-channel',attemptId:'recalibration-attempt',channelIndex:1};next.calibration=restCalibration(next);
 for(const record of [rest,next])assert.equal((await f.call('POST','/practice',{id:f.participant.id,record})).status,200);
 const record={...f.capture('pinch'),flowVersion:2,captureProcedure:'button',channelIndex:1,calibration:next.calibration,firstCrossingAt:null};
 const result=await f.call('POST','/practice',{id:f.participant.id,record});assert.equal(result.status,200,JSON.stringify(result.body));
});
