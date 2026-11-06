# Two-wrist guided Practice refinement (isolated candidate)

Base: delivered source `3cb4b4be2c80d0e1a7be1f2771592383b3470ca6`, local branch `feature/two-wrist-guided-practice`. Only `/workspace/EMG-Pilot-Refinement` was edited. No commit, push, production SDK repair, survey edit or laptop deployment.

## Current contract

- Active IDs are **`wrist-up` / Wrist up** (extension) and **`wrist-down` / Wrist down** (flexion), palm down. The existing default-driven collector, training pipeline and game mapping now use those IDs: Wrist up → jump; Wrist down → switch lane. Mock remains computer-generated input, not a simulation of physiological differences between wrist movements.
- Practice requires **three retained examples per wrist** (six total). Deleting one leaves five and closes Train/Play until replacement. The measured per-gesture minimum/maximum settings are untouched.
- Rest is still a separate ten-second calibration/readiness procedure, not a training class. Frozen mean + 3 population SD, activation/rest holds, cooldown, source epochs, raw signed values/timestamp ties and normal countdown are unchanged.
- New Practice archives use **`flowVersion: 3`**. Server validation distinguishes their two classes/six retained samples and canonical game labels from historical v2/legacy three-class records. Historical IDs/labels remain unchanged in storage/export; they are never renamed to wrist IDs. Restored measured sessions containing older classes are preserved but not resumed as mixed wrist sessions: the app asks the researcher to archive them and use a new participant session.
- Opening the actual saved Graph displays guidance **inside its dialog**, explains time/activity/display-only meaning, and highlights the actual upper-right X. Escape, initial focus, Tab containment and focus restoration work; background Practice guidance is not mounted behind it. Raw details/CSV are unchanged and collapsed.
- Results separates game score, recognition accuracy, unsuccessful Unknown and unscored recording failures. Its explanation describes Replay game (same samples/model), Review Samples / Retrain, and the actual Continue label. Only the actual replay action was renamed. Results Practice guidance stays in normal document flow so it cannot cover bottom actions.

## Verification and evidence

Evidence root: `/workspace/EMG-Pilot-Refinement-Validation` (not part of the source delivery). Each implementation slice has a recorded meaningful RED and subsequent GREEN: wrist/versioned API, six-sample quota, dialog guidance, Results wording, historical-session isolation, Results overlay regression, and canonical v3 game labels. Existing mounted recorder/recalibration/training-race coverage was updated to the changed active set/dose; historical v2 API tests were retained.

Baseline: 101/101 tests, typecheck and build passed with reused cached dependencies. Final counts and exact changed/new paths are in `verification.json` / `manifest.json` in the evidence root. No dependency installation or package-file changes were made; test tooling relies on the existing external Playwright and matching React test renderer.

`browser-button-verified/report.json` and `browser-threshold-verified/report.json` passed actual mounted Mock recorder → review (Graph, keyboard/X, delete/replacement) → Train → actual game → Results → saved Practice completion → measured wrist capture/recalibration/rejoin/export. Each saved six retained Practice samples; actual predictions included Unknown/wrong, not invented successes. Original defaults were used in Practice; Button's separate measured zero-countdown keyboard regression explicitly sets zero then restores 3000ms. Screenshots and geometry cover 1440×1000 and 1280×720. Both exported ZIPs preserve actual waveform timestamps/signed values/calibration lineage.

### Parent replay verification and independent review

The implementation worker exhausted its original internal two-game-per-condition budget while fixing a Results overlay, so its earlier `browser-*-verified` reports correctly retain `actualReplayVerified: false`. The parent explicitly extended that engineering budget for one clean additional journey per condition; each ran an initial game and an actual same-session replay. Both `parent-button-replay/report.json` and `parent-threshold-replay/report.json` report `passed: true`, `actualReplayVerified: true`, `actualGameRuns: 2` and `cleanedFixture: true`. The harness verifies identical training IDs and retained sample IDs across initial/replay runs. No new sample capture or training is substituted for replay. Maximum aggregate across worker and parent attempts is four actual games per condition; failed earlier evidence remains preserved.

Fresh-context independent review passed with no blocking security or logic findings (`independent-review.json`). Its replay dependency was closed by the parent's browser evidence, not by attributing browser execution to the reviewer. An optional broader historical-session regression remains a nonblocking suggestion. The parent also reran all 108 tests, typecheck/build, the survey validator/scoring checks and both ZIP CRC checks. This documentation-only verification update follows the reviewed application-code snapshot; application behavior did not change after review.

Production preview was rechecked and still crashes with inherited **`exports is not defined`** (`production-preview.json`); it was not repaired. Browser evidence is development-mode only. The inherited Recharts spread-key warning and intentionally induced 503 responses are recorded, not hidden. The older pre-shared-flow browser scripts listed as historical in `GUIDED_PRACTICE.md` remain historical and were not claimed as passing current acceptance.

## Limits / handoff

No AB/BA redesign, retry restriction, preprocessing/classifier change, real participant data, physical Ganglion/BLE validation, reliable wrist-recognition claim or native laptop deployment. Three examples are rehearsal dose, not proof of accuracy. Candidate source is local/unpublished; parent verification and independent review passed for the requested refinement, not participant-study or production-runtime readiness. All harness-owned browsers/servers and temporary API directories are closed/removed in `finally`.
