# Guided rehearsal using the actual study flow

## Scope and checkpoint

The faithful rehearsal pass starts from local checkpoint `dc1ab3ed3cf87ef9c56cc593574db8df96a6b613` (participant theme/error/debug controls), following guided Practice/rest fixes in `4b31811`. The user-accessible branch is `feature/real-flow-practice`. No branch was pushed. This is not the older calibration candidate.

The user approved replacing the separate Practice interface with guidance on the actual app controls, keeping Relax as a resting-hand class with the same cued capture in both conditions, explicit test participants, and small hierarchy/border improvements. Detector/calibration/scaling parameters, gesture-to-action mappings, within-participant condition schema and surveys are not redesigned here.

## Participant journey

1. **Preparation:** introduction, connect/start the signal, explore, then save/read back a separate ten-second resting reference. This reference does not train the classifier or set a new detector calibration.
2. **Capture:** the actual StudySession capture controls and sample list collect one practice example per existing gesture. Button/Threshold remain assigned for active gestures. Relax uses the identical configured preparation countdown and fixed Button-recorder window in both conditions; it does not require an activity crossing or release movement.
3. **Review:** use the actual Graph/Delete controls, remove an example, return to Capture to replace it, and inspect a retained example.
4. **Train:** the actual classifier builds a separate practice model from the retained practice samples.
5. **Play:** the actual mounted game requests predictions from that practice model. Wrong and Unknown are genuine possible results, not reasons to invent a success.
6. **Results:** the actual Results panel shows the run. Begin collection requires saved/read-back review, replacement, training and a game with a scored attempt, then a completion archive.
7. **Measured collection:** return to the original measured session with its data/model preserved. A first fresh session still has no measured examples/model; practice is not promoted. The existing Mock connection stays running across this transition. Physical Bluetooth continuity remains a hardware check.

While model construction and its archive save are pending, conflicting deletion, stage changes and reopening guidance are guarded. Graph inspection and Leave remain available. A failed immutable save is retained for recovery; after a persistent outage, save the queued record and train again rather than treating an unarchived model as ready.

The guidance distinguishes the task, the currently selected gesture and the next selection. Practice uses the same stage UI, not duplicate practice capture/review widgets. Stronger panel borders and a prominent Practice objective improve separation without a new visual design. Focused controls retain native Space activation; background Space and focused Capture Space record through the shared controls.

## Isolation and recovery

Measured `emg-study-session`, collection archives and model scope are distinct from the in-memory rehearsal session/model scope. Practice drafts/models restart after reload; saved practice archives remain evidence, not restored readiness. Existing measured retained examples can restore/rejoin separately. Reopening guidance must not delete measured examples or replace the measured model.

The immutable `/api/study/practice` archive keeps `flowVersion: 2` rest, capture, event, reviewed, removed, training, game and completion records. Active condition, generation, source/channel/settings and sample/model/game lineage are checked. The queue retains failed records verbatim; Retry reuses their IDs and requires readback. Legacy practice records remain compatible and immutable. Practice records are separate in exported `practice.json`, not measured training waveforms/results.

Relax archives distinguish assigned condition, actual Button recorder mode and `captureProcedure: cued_rest`. Measured completion events also trace that procedure independently of assigned condition. Recognition correctness compares predicted/requested gesture IDs independently of obstacle success; game score and mappings are unchanged.

The resting reference preserves original supplied values/timestamps, including distinct equal-time samples and endpoint pairs, using stable source-object consumption. Timing diagnostics explicitly mark the device clock unverified. This is not a sampling-clock repair or physical signal validation. The rolling display retains its four-second window without truncating the archival reference.

## Test/demo participants

Authenticated researcher ID generation has a **Test/demo participants** checkbox. Explicit test IDs retain Mock and developer settings; ordinary study IDs use Ganglion. Legacy missing flags default to false. Join/list/storage/reset/export preserve the flag, and server labels derive from the stored participant, not a join payload override. This does not replace the baseline participant-ID-based trust model with a new authentication system.

`npm run review:practice` creates disposable explicit test IDs for both assignments, private API data/cache directories and prints the URL/IDs. It does not use repository `data/`. Default localhost port is 5214; an occupied port fails without stopping another server. Ctrl-C cleans disposable records. Existing actual participant data is not included in commits or candidate delivery.

## Verification commands

```sh
npm test
npm run typecheck
npm run build
npm run test:practice
```

`test:practice` runs `tests/browser-real-flow.mjs` for Button by default. Set `EMG_PRACTICE_CONDITION=threshold` for Threshold and `EMG_PRACTICE_EVIDENCE` to keep its report/screenshots/readbacks/export ZIP. It exercises real Mock recording, replacement/training/game/Results, fault recovery, zero countdown and fresh-browser measured restoration. Maximum two game runs are allowed; absence of a scored attempt fails rather than being seeded.

`node tests/browser-participant-flags.mjs` exercises the actual admin generation/roster/join workflow. `EMG_FLAG_EVIDENCE` selects its output. Playwright is an external QA prerequisite, overridable with `EMG_PLAYWRIGHT_MODULE`; no app runtime dependency was added. The lifecycle unit tests additionally require `react-test-renderer` matching the React peer version (18.3.1). Verification reused the installed QA renderer and did not exercise a clean dependency installation; app operation does not require that renderer.

The earlier `browser-guided-practice`, `browser-dismissible-notices`, `browser-theme` and paired-replay scripts describe previous UI structures and are retained as historical regression tooling, not the current end-to-end acceptance entry point. Their earlier reports do not substitute for the shared-flow run.

## Limits

The ten-second reference, existing countdown/window settings and one-example practice dose are prototype engineering choices, not validated study parameters. No real Ganglion/BLE/electrode/device-clock, participant understanding or classifier-accuracy validation is claimed. Mock Wrong/Unknown results are honest software-path evidence only.

The inherited production-preview SDK crash (`exports is not defined`) remains untouched. Typecheck/build success is compilation evidence; current browser journeys use Vite development mode. Adaptive detector/display behaviour and the general measured-recorder timestamp limitations remain separate work. Do not call this production-ready or participant-study-ready on the basis of these tests.
