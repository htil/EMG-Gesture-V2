# Formative Pilot Handoff

## Repository and scope

Implementation branch: `study/formative-pilot`.
The isolated worktree is `C:\Users\vdingram\Downloads\EMG Gesture Training Interface\pilot-worktree`.
The original `C:\dev\repos\EMG Gesture V2` checkout remains on `main`.
No commits or pushes were made for this implementation.

The study compares Button Start (A) with Signal Start (B), within subject, in assigned AB/BA order.
Each period uses a new dataset and model. The same gestures, channel, features, classifier, duration,
normalization reference, Testing schedule and Results code are used in both periods.

## Before this change

- `TrainingScreen.tsx` owned navigation, samples, the shared signal source and snapshots passed to Testing and Results.
- Training had automatic threshold capture but no manual sample-start action. The main Start button started the stream.
- `useGestureRecorder.ts` combined crossing detection, capture, pre-trigger samples and cooldown in React effects.
- Stopped recorders could process retained buffers, and Training remained able to record behind Testing.
- Live captures included 175 ms of pre-trigger samples in addition to the configured duration.
- Display sensitivity affected live trigger normalization, which continued adapting during collection.
- Live quality feedback compared raw voltage to a normalized threshold. It was not a validated quality assessment.
- Testing either classified complete replay/generated samples, or captured continuous streams using thresholds.
- kNN, training-only normalization, both feature sets and leave-one-out evaluation already existed.
- Dataset JSON/CSV export existed; participant/condition tracking, durable study logs and dataset import did not.
- Disconnect events updated status, but silent stream stalls had no watchdog.
- Results summarized PredictionRecords. Confidence is model support, not held-out accuracy.
- There was no automated test command.

## Priorities

| Priority | Work |
| --- | --- |
| P0 | Shared recorder, manual/signal adapters, equal duration, raw provenance, stopped/background Training guards, tests. |
| P1 | AB/BA session tracking, locked shared settings, independent periods, event archive/export, neutral cue-timed Testing, dropout recovery, operator rehearsal. |
| P2 | Physical hardware validation, approved instructions/questionnaires, retention procedure and documented handling of interrupted trials. |
| PARK | Adaptive-threshold conditions, classifier/feature tuning, boundary editing, gamification, Results redesign. |

## Recording behavior

`recorder/recorderMachine.ts` implements capture; `useGestureRecorder.ts` is its React adapter.
Pilot A and B use zero pre-trigger time and the same half-open interval `[trigger, trigger + duration)`.
The first point at/after the end confirms completion but is not included in the waveform.
Original decoded raw values are saved. There is no resampling or display normalization of saved values.
Sample count may vary with arrival timing; the configured window duration is stored explicitly.

Button Start requires a fresh point and an explicit Record Sample action.
Signal Start requires observation below the lower hysteresis threshold before a crossing.
Falling below threshold during a capture does not cancel it.
Both use a 350 ms cooldown. Signal rearming additionally requires relaxation to 70% of the trigger threshold.
Gaps/stalls over 250 ms or fewer than six captured points reject a capture and log the reason.
Six points is a minimum continuity guard, not a scientific signal-quality test.

The existing preparation stream supplies the normalization baseline and upper reference.
Beginning the pilot freezes that reference and all common settings across both periods.
Mock sessions may begin while idle; no hardware preparation or practice samples are required.
Live sessions still require a running stream, at least seven decoded samples, and no active capture.
Begin Pilot Session validates participant code, AB/BA order and settings before enabling, and
shows the blocking field or preparation step beside the button. Session creation repeats the same
configuration validation. An active practice capture must finish or be stopped before either mode begins.
This is a fixed reference, not an adaptive-threshold study condition.
Live sensitivity and feature selection are locked during the session.

Training records only on its own screen and only while an empty slot exists.
Changing gesture/source/context or stopping the stream aborts an unfinished capture.
Pilot feedback does not label captures as scientifically good/weak/noisy.
Outside pilot mode, existing diagnostic modes remain available.

## Sessions and exports

`StudyProvider` survives period changes; the working Training/Testing subtree is remounted per period.
The archived first period remains exportable but is not passed into the second period's model.
Each dataset mutation increments its period's dataset version and invalidates its model version.
Late events retain their originating period.

Use pseudonymous participant codes, not names. The archive includes:

- Session UUID, participant code, assigned sequence, period, condition and frozen configuration.
- Append-only indexed/time-stamped events with dataset version.
- Trigger attempts, source/time, gesture, completion/failure reason and raw point counts.
- Accepted samples with raw data, features and attempt provenance; deletion/recollection remains visible in history.
- Model creation and leave-one-out summary with source sample IDs.
- Testing settings/timeline, phase changes, captures, predictions, missing trials, pauses/resumes and completion.
- Connection status/errors and screen changes.

Export Study JSON is the complete study archive, including both datasets, events and Testing sessions.
Export Events CSV contains one event per row; its detail column is JSON.
Existing dataset exports remain separate and should not substitute for the full study archive.
The local backup is stored under `emg-formative-pilot-v1` in browser localStorage.
It is not encrypted. Export to the lab's approved storage and clear the browser backup afterward.
Storage failure blocks capture. Refresh/restart presents recovery/export instead of silently resuming a period.
Development hot reload can also interrupt a session; use a production build for participant sessions.

## Neutral Testing

Pilot Testing uses the same shared raw stream and recorder in both conditions.
One scheduled capture starts shortly after the target cue (250 ms eligibility delay), with the training duration.
The trial must have room for capture and completion. The prepared trial period is at least duration + 1000 ms.
Signal threshold crossings and participant clicks do not select Testing boundaries.
Expected gesture is attached only after feature extraction and kNN prediction.
Replay Training and Channel 1-4 remain development diagnostics outside pilot sessions.
Pilot Mock Live uses newly emitted source points rather than replaying recorded training samples.
Mock data checks software behavior; its accuracy is not evidence for live EMG performance.

Missing/failed trials must be included in study analysis using the event log, not silently omitted from a reported score.
Results retains its existing contract and layout. Its confidence summaries are not accuracy estimates.
The leave-one-out card is a secondary within-dataset diagnostic, not an independent live test.

## Manual procedure for the developer and John

1. In this worktree run `npm install`, `npm test`, `npm run build`, then `npm run dev` for development.
   For the participant rehearsal use `npx vite preview --host 127.0.0.1 --port 5189` after building.
2. John observes and records deviations; the developer acts as participant. Swap roles for the second rehearsal.
3. Start with Mock, two gestures, two target samples, and 1200 ms duration. Start the stream.
4. In Session Settings enter a code such as `DRYRUN_AB`, select AB and Begin Pilot Session.
   Expect practice data cleared, an idle stream, period 1 Button Start, and locked shared settings.
5. Start Stream. Wait for Record Sample to enable. Let a mock peak pass without clicking: no sample should be saved.
6. Record two samples for each gesture. Each click produces one complete duration; a falling signal does not cancel.
   Stop during one capture: expect no accepted partial sample and a failure message/event. Restart and recollect.
7. Delete one saved sample, recollect it, then use Test. Expect the model to use only the current dataset version.
8. Start Testing. Follow each cue. Expect one scheduled prediction per successful trial, rest periods, and working pause/resume.
   Do not expect every synthetic prediction to be correct. At completion Results should show the recorded predictions.
9. Return to Training. Counts should match the pre-Testing dataset, with no extra background recordings.
10. Export Study JSON and Events CSV. Confirm ordered event indices, participant/period/condition IDs,
    trigger-to-sample joins, deletion/recollection, model version, prediction records and completion events.
11. End Period / Next Condition. Expect period 2 Signal Start, no working samples/model/history, and the same settings.
    The archive must still contain period 1 data. Start Stream, relax below the threshold, then cross it.
12. Complete period 2, Testing and Results. Finish Study and export again. The archive should contain both periods and session_completed.
13. Start a new synthetic session with BA. Confirm Signal Start is first and Button Start second, with fresh datasets in both.
14. Reload once during a disposable dry run. Expect recovery/export, not automatic streaming or mixed data.

## Physical Ganglion checks before participants

- Repeat the full AB and BA flow with the actual browser, board and forearm electrode placement.
- Verify a normal brief contraction reliably triggers B; A works below or above the threshold when clicked.
- Confirm both conditions save raw signed values and comparable configured durations and point counts.
- Check battery/disconnect, BLE chooser cancellation, reconnect, and a silent stall during Training and Testing.
- Confirm incomplete captures fail, old buffered points are not reused, and restarting does not create duplicate samples.
- Check arrival timing and the 250 ms continuity limit under real BLE batching; short packet loss is not comprehensively detected.
- Confirm fixed normalization remains usable in both periods without changing threshold or electrode placement.
- Repeat exports at the largest planned sample count to check browser storage capacity.

## Advisor/operator decisions

Confirm the shared gesture list, duration, count, channel and feature set before the pilot.
Approve the fixed-reference preparation procedure, neutral Testing cue delay, and treatment of missing/interrupted trials.
Use the already-finalized research question and assigned AB/BA sequence; the software does not assign participants randomly.
Workload and educational measures still require the approved questionnaire/interview procedure outside the app.
Agree on consent, local data retention and transfer to lab storage before recruiting participants.

## Validation status

The `VALIDATE_AB` browser dry run on `http://localhost:5187` used Pinch/Squeeze,
two samples per gesture, 1200 ms captures and 15 neutral Testing trials per period.
Both Button Start and Signal Start completed Training -> Testing -> Results with 15 predictions each.
Finish Study completed successfully; capture screens disappeared and export/New Session remained.
The synthetic archive was retained. A later development reload may present its recovery screen.
Returning from the first Results preserved the four Training samples. The second period began idle
with zero samples for both gestures, no Testing handoff, and the same locked settings. Testing's
model debug showed four new samples, not eight accumulated samples.
The older recovered study at `http://127.0.0.1:5187` was not cleared or modified.

Automated tests cover recorder boundaries, stalls, sequence IDs, AB and BA period/model isolation,
late-event attribution, append-only history, neutral evaluation reuse, scheduled Testing and the
unchanged Results data contract. Serialized complete AB/BA JSON and event CSV are checked for
participant/session/sequence/period/condition, trigger/capture provenance, model/evaluation/testing,
failure/reconnection status, and completion/export events. These are code-level payload checks,
not an inspection of a downloaded browser archive. Physical JSON/CSV download still needs one
human check. BA ordering is automated-test coverage; repeat the BA browser rehearsal with John.

The mock run is a workflow check, not classifier validation. Period 2 returned Unknown for all
15 trials. Its tiny training set had a constant feature, and the existing normalization's 1e-6
scale floor can produce enormous distances for new values. No classifier or thresholds were tuned.
The all-Unknown Results summary bug is fixed: when no listed gesture has a recognized prediction,
Most Common displays "No recognized gesture" instead of the first gesture. Empty sessions use the
same fallback. Recognized-gesture selection, history, counts, and the Results layout are unchanged.
A regression test covers all-Unknown, empty, and mixed recognized/Unknown sessions without mutation.

Native Brave confirmation dialogs required the operator to click OK because browser automation
timed out while they were open. No successful physical browser download is claimed.
Build warnings about OpenBCI `eval` and a large JavaScript bundle predate this implementation.
The suite now contains 29 tests, including session-start, Results, mock timing and keyboard regressions. See the final task report for
the latest post-fix test and build results.
There are no separate lint or type-check scripts; the build transpiles TypeScript through Vite.
No claim of live-hardware validation is made by a passing build or mock test.

## Changed files

Modified: `README.md`, `package.json`, `package-lock.json`, `src/main.tsx`,
`src/app/TrainingScreen.tsx`, `src/app/TestingScreen.tsx`, `src/app/useGestureRecorder.ts`,
`src/app/useSignalSource.ts`, `src/app/ganglion.ts`, `src/app/pipeline/types.ts`,
`src/app/pipeline/mockTrainingData.ts`, `src/app/pipeline/resultStatsCalculator.ts`.

New: `src/app/recorder/recorderMachine.ts`, `src/app/study/StudyProvider.tsx`,
`src/app/study/studySession.ts`, `src/app/study/neutralTesting.ts`,
`src/app/study/mockGestureSignal.ts`, `src/app/recorder/buttonStartShortcut.ts`,
`src/app/recorder/useButtonStartShortcut.ts`,
`tests/pilot.test.ts`, `scripts/run-tests.mjs`, `docs/FORMATIVE_PILOT.md`.

The lockfile includes the direct test-runner esbuild dependency and npm-generated optional
Tailwind/WASM bundled metadata. No unrelated lockfile cleanup was performed in validation.

## Safe merge procedure

No commit or merge has been made. Review the known issues and finish the hardware/operator gate
before calling this participant-ready. The active checkout is on main at `bf69c01`, ahead of the
currently cached origin/main by one commit; preserve that local commit and its `.codex-tmp/` directory.

In PowerShell, first commit only this worktree's reviewed files:

```powershell
Set-Location 'C:\Users\vdingram\Downloads\EMG Gesture Training Interface\pilot-worktree'
git status --short --branch
git diff --check
npm test
npm run build
$pilotFiles = @(
  'README.md', 'package.json', 'package-lock.json', 'src/main.tsx',
  'src/app/TrainingScreen.tsx', 'src/app/TestingScreen.tsx',
  'src/app/useGestureRecorder.ts', 'src/app/useSignalSource.ts', 'src/app/ganglion.ts',
  'src/app/pipeline/types.ts', 'src/app/pipeline/mockTrainingData.ts',
  'src/app/pipeline/resultStatsCalculator.ts',
  'src/app/recorder/recorderMachine.ts', 'src/app/study/StudyProvider.tsx',
  'src/app/recorder/buttonStartShortcut.ts', 'src/app/recorder/useButtonStartShortcut.ts',
  'src/app/study/mockGestureSignal.ts',
  'src/app/study/studySession.ts', 'src/app/study/neutralTesting.ts',
  'tests/pilot.test.ts', 'scripts/run-tests.mjs', 'docs/FORMATIVE_PILOT.md'
)
git add -- $pilotFiles
git diff --cached --stat
git commit -m "Add formative pilot conditions and study session tracking"
```

Stop the worktree dev server before reinstalling shared dependencies. In the active repo:

```powershell
Set-Location 'C:\dev\repos\EMG Gesture V2'
git status --short --branch
git fetch origin
git switch main
git merge --ff-only origin/main
git merge --no-ff --no-commit study/formative-pilot
npm ci
npm test
npm run build
git diff --cached --stat
git commit -m "Merge formative pilot recording and session flow"
```

Run each command only after the previous one succeeds. Stop if tracked work is dirty, the remote
update cannot fast-forward, conflicts occur, or validation fails. Do not reset or force-push to
resolve divergence. Review any new main changes and rerun the manual workflow after integration.
Publishing with `git push origin main` is a separate decision after review; it is not automatic.

## Mock and keyboard rehearsal

Pilot mock profiles follow the frozen gesture ordering, not the Ganglion channel: the first three
use a slow oscillation, double oscillation, and faster ripples. Their active profiles repeat over the
configured duration, with an active interval of duration + 1000 ms and then 1200 ms of quiet signal.
They are deterministic diagnostic envelopes in arbitrary units,
not realistic EMG, a no-gesture class, or evidence of classifier accuracy. Even a gesture named Relax
receives an active diagnostic profile. Existing non-pilot channel diagnostic generation is unchanged.
Pilot Testing selects the source profile from its cue; the target never enters feature extraction/kNN.
Each neutral trial cues a fresh mock phase, including repeated gestures, rather than letting countdown
time or the preceding trial determine the capture phase. Neutral capture still starts after 250 ms.
The real Ganglion source, threshold, shared recorder, duration, feature sets and classifier are unchanged.

### Mock timing regression (2026-09-10)

The previous active interval lasted exactly one capture duration. At 1200 ms / 20 Hz,
Signal Start captured 24 active points, whereas a 250 ms delayed neutral capture included five quiet
points. Reproduction through RecorderMachine, buildTrainingSession and createPredictionEngine gave:

| Signal-trained class | Training RMS / std | Neutral RMS / std | Nearest distance | Decision |
| --- | --- | --- | --- | --- |
| Pinch | 0.7665 / 0.0564 | 0.6982 / 0.2885 | 33.8795 | Unknown |
| Squeeze | 0.7925 / 0.0713 | 0.7163 / 0.3017 | 34.7643 | Unknown |

Button captures at 250-350 ms contained the same quiet tail and matched neutral captures.
The primary cause was window-phase mismatch, not late Signal triggering. Secondary causes were
narrow deterministic feature variance and source epochs not resetting for every Testing trial.
The Signal training feature standard deviations were all above the normalization floor in this
two-class reproduction; zero variance was not necessary to produce the failure. Point counts,
fixed duration, raw path, hysteresis and cooldown were not the cause. Normalization remains fit only
on training data; no classifier, feature or confidence settings were changed.

After the source correction, the same three-example Signal reproduction had nearest distances
1.0279 and 0.8592 (recognized). Regression coverage uses two examples per class, both feature sets,
1200/1500 ms durations and neutral delays of 250/300/400/650 ms through the real recorder and kNN.
Set MOCK_TIMING_DIAGNOSTICS=1 when running the Mock timing test to print full feature vectors,
training standard deviations, normalized vectors, neighbors and decisions.

Use a NEW mock dataset in both periods after this update. For Button Start, click during the early
active region; deliberately recording quiet/late windows is still allowed and may yield Unknown.
No capture is automatically aligned to a button click and no predictions are forced. These tests
do not establish live EMG accuracy or browser timing under load. Repeat AB and BA in the browser.

The recording controls remain mounted when feedback changes. Capture/stream/Test buttons have fixed
dimensions, Test stays visible but disabled until ready, and status space is reserved. Sample previews
still open explicitly on selection. Keyboard capture uses the same manual handler and `button` event
as clicking Record Sample. It ignores held/repeated keys, modifiers, composition, typing controls,
other focused buttons/links, and visible dialogs. Focused buttons retain their normal keyboard behavior.

Browser validation on isolated localhost:5188 confirmed one Spacebar capture, one clicked capture,
no capture through the open Settings dialog, and identical capture/stream/Test button bounding boxes
before and after a capture. The existing study backups on other origins were not cleared.

Short checklist:
1. Mock A: switch gestures and confirm distinct profiles; click Record Sample for a full duration.
2. Keyboard: focus the page, tap Space, then hold it. Expect one capture, not repeated captures.
   Open Settings or type into an editable control: Space must not start recording.
3. Mock B: relax/quiet interval, then threshold crossing; expect one full capture and cooldown.
4. UI: repeat captures, fill a gesture and change gestures; controls remain in place and Test enables in place.
5. Export: download study JSON/CSV and check raw samples, labels and `button`/`signal` provenance.
6. Hardware next: repeat A/B with Ganglion, check brief bursts, raw points, disconnect/reconnect and export.

## Existing inference interface

No game implementation or game architecture was added. A future caller can reuse:

1. `useGestureRecorder` with manual trigger mode and a configured duration; call `startRecording('button')`
   for manual initiation or `startRecording('scheduled')` for an externally scheduled capture.
2. On `completedSegment`, map `{ time, value }` to `{ time, raw: value }` and call
   `buildInferenceSample(points, completedSegment.durationMs)` to obtain an unlabeled inference `EmgSample`.
3. Reuse `createPredictionEngine(trainingSession).predict(sample)`. It performs the existing feature
   extraction, normalization and kNN and returns prediction/confidence/Unknown plus existing diagnostics.
4. Acknowledge the completed segment exactly once. Expected targets are compared only after prediction.

Game cues, scoring, rendering and lifecycle adapters should wait for the game task. No classifier
tuning or game-specific refactor is needed to expose the current capture-to-prediction composition.
