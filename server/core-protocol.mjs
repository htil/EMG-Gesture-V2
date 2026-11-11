import crypto from 'node:crypto';
export const PILOT_PROTOCOL = 'between-subject-v2';
export const PREVIOUS_PILOT_PROTOCOL = 'between-subject-v1';
export const HISTORICAL_PILOT_PROTOCOL = 'within-subject-v1';
export const PILOT_GESTURES = ['wrist-up', 'wrist-down'];
export function isPilot(record) { return [PILOT_PROTOCOL,PREVIOUS_PILOT_PROTOCOL,HISTORICAL_PILOT_PROTOCOL].includes(record?.protocol_version); }
export function pilotRepetitions(record) { return record?.protocol_version === HISTORICAL_PILOT_PROTOCOL ? 2 : 1; }
export function conditionOrder(participant) {
 if([PILOT_PROTOCOL,PREVIOUS_PILOT_PROTOCOL].includes(participant.protocol_version)) return [participant.condition];
 return participant.condition_order === 'threshold,button' ? ['threshold','button'] : ['button','threshold'];
}
export function protocolSequence() {
 // Rejection sampling retains balance and excludes long runs and pure alternation.
 for (;;) {
  const result = [...Array(10).fill('wrist-up'), ...Array(10).fill('wrist-down')];
  for(let i=result.length-1;i>0;i--) { const j=crypto.randomInt(i+1); [result[i],result[j]]=[result[j],result[i]]; }
  let streak=1, max=1; for(let i=1;i<result.length;i++) { streak=result[i]===result[i-1]?streak+1:1; max=Math.max(max,streak); }
  if(max<=3 && max>1) return result;
 }
}
