# Pre-pilot combined integration

## Candidate and provenance

- Branch: `pranay/flow-based-ui`.
- Windows merge checkout: `C:\Dev\HermesWorkspace\EMG-Pranay-Integration-20261111`.
- Reviewed source integration commit: `9992311aa161003a0a70dae0e1f277461fd56c31`.
- Destination before merge: `24d9537945c3ad6054bbfb91b7edbe9c6ebd1d69`.
- Base: `e9cb57359c29cddaf4650c2df85a65c69aa877f0`.
- Protected rollback: `pre-pilot-20261111`, unchanged at the base commit.
- This is the requested history-preserving publication onto Pranay's branch. The original baseline and reviewed source checkout remain unchanged. Destination-only files, including tracked records, retain their original bytes. Read the actual merge commit with `git rev-parse HEAD`.

## Changes retained and integrated

**Existing study and Pranay's flow UI.** `App.tsx`, `FlowBasedCaptureScreen.tsx`, `StudyFlowCanvas.tsx`, shared components and styles already match the latest `pranay/flow-based-ui` branch. Pranay's earlier collection, waveform inspection, replacement and workflow implementation remains in the evolved study code; it was not replaced with an older server or session controller. Participant entry/session/admin and the `/lab` route are unchanged.

**Safe participant entry.** Reuses the separately verified ID-entry patch: actual earlier-save failures are visible, Retry uses the same queued payload and endpoint, and a ten-second deadline cancels only the entry screen's observer. It does not cancel sends, discard queued recordings, release another ACK waiter, rewrite scope, or open an ID without a real complete ACK. A late cancelled response cannot navigate or replace participant storage.

**John's game feedback.** Source is `24d9537945c3ad6054bbfb91b7edbe9c6ebd1d69`, authored by John on `pranay/flow-based-ui` (not the older `gamification` branch). Includes red recording-zone lane segments, projected guide arrows, shorter tutorial text, timer/lives/track explanations and the docked track guide.

## Intentional conflict resolution

The histories have no merge base because the protected baseline comes from a source-only snapshot. The source branch also contains historical data paths. The integration therefore selects John's four-file presentation commit, not a whole-history merge or import of upstream records.

- Kept the scoped tutorial coordinator, source hold/resume controls, guarded tutorial release, new-rest resume gate, model/run identity and pause-duration accounting.
- Kept eight unscored tutorial obstacles and twenty official trials. Did not restore the upstream branch's obsolete ten-obstacle state machine.
- Existing movement speed 10, recording lead 30 and ready lead 38 remain unchanged. The red visual zone is derived from `RUN_SPEED * 2`, ending at `RECORDING_START_DISTANCE - length`; it does not introduce the upstream branch's old 22/12-unit timing. The real sample-backed two-second capture and action deadlines remain authoritative.
- Timer/lives/track explanations are presentation substeps inside the same existing intro hold. They do not remount the runner, begin acquisition or add runs/trials. Only the final introductory Next releases that hold.
- Backend, acquisition algorithms, Ganglion parsing, calibration, measured quota, training/model locking, Submit, repeated-round journals and fixed Button/Threshold assignment remain unchanged.

## Validation

Combined validation: **108/108 focused tests passed**, with zero failed/cancelled/skipped across 19 selected suites. This includes five ID-entry recovery regressions, three new game-feedback tests, full mounted repeat-round acceptance (16), backend round-advance acceptance (14), both-condition sample-backed 20-trial gameplay/reconnect/export checks, queue/context recovery, calibration and admin controls. Typecheck and production build passed on a byte-identical Linux mirror using existing cached dependencies and disposable records. This is not a full unfiltered test-suite or native Windows/Ganglion acceptance.

Production UI/API startup and restart smoke passed with an owned disposable external store; its server settings hashes were retained unchanged. This is Linux software startup evidence, not native Windows/hardware or real participant-data recovery acceptance. Independent static review passed with no introduced security or logic blocker; it is not hardware or participant-readiness approval. The reviewed production/test hashes match the final candidate. On resumption, the five ID-entry, three game-feedback and two runner-recovery checks were rerun: 10/10 passed. Final evidence is stored outside the source checkout under `EMG-Game-Reconnect-Rounds-Validation-20261109\final-integration`.

## Windows / Surface engineering verification

Use this local folder and branch, not the historical clone recipe below the current notice in README. Confirm `git branch --show-current` and `git rev-parse HEAD`. Use native Node.js 22 and dependencies installed for this computer, never a copied Linux `node_modules` symlink.

If this new candidate has no native dependencies, install them locally; do not alter dependencies in the preserved fallback:

```powershell
Set-Location 'C:\Dev\HermesWorkspace\EMG-Pranay-Integration-20261111'
npm.cmd ci --include=dev --include=optional
if ($LASTEXITCODE -ne 0) { throw 'Install failed' }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
```

Use the existing approved external record directory for an existing study; do not silently create a fresh store to bypass a rejection. Keep the existing local researcher credential. For a NEW disposable rehearsal, deliberately choose a separate external rehearsal store and only synthetic/test IDs.

```powershell
$records = Read-Host 'Absolute path of the existing approved external record directory'
if (!(Test-Path -LiteralPath $records -PathType Container)) { throw 'Existing record directory required' }
npm.cmd run pilot -- --production --data-dir "$records" --host 127.0.0.1 --port 5221
```

Keep the terminal open. Production UI is `http://127.0.0.1:5221/`; researcher access is `/admin`. Use a Web-Bluetooth-capable Windows browser with explicit device permission and Bluetooth enabled. Verify the actual Surface/device rather than assuming another computer's success transfers.

**Browser-origin warning:** the reported browser queue was at `http://localhost:5173/`. A different host/port/profile has different browser storage. Opening this candidate on 5221 does NOT recover that queue. Preserve the original browser profile/storage and confirm its original record store before any recovery. Do not move an affected participant to a fresh browser to evade pending saves. Server port is configurable if an authorized recovery must retain the original origin.

## Remaining readiness gates

This integration is not participant-ready merely because software tests pass. Permanent wrong-generation, wrong-store or immutable-context rejection stays blocked and visible. No historical recovery or unsafe bypass is included. The original immutable-context producer/retry cause remains unresolved.

Before participant collection: recover/resolve the actual rejected records without altering their evidence, and complete Button and Threshold on the intended native Ganglion/Surface setup through capture, reconnect/new rest/resume, Submit, repeated round, export and restart with all pending saves acknowledged. No hardware acceptance is implied by temporary API fixtures or synthetic sample streams.
