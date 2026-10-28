# Participant UI and test options

The local UI checkpoint is `dc1ab3e`; the current shared-flow rehearsal is described in [GUIDED_PRACTICE.md](GUIDED_PRACTICE.md). This document covers presentation and debugging, not a new calibration protocol.

## Light mode

The participant Light mode toggle defaults dark and stores only `emg-ui-theme`, separately from measured session state. Invalid/blocked preference storage falls back safely. Text, surfaces, charts and game HUDs are themed; WebGL pixels are not filtered/inverted. Admin remains unthemed.

## Error details

Hide details leaves an unresolved summary, underlying error/readiness state and recovery controls intact. Show details restores the message. New/retried errors expand again, including identical text. Hiding a failure cannot discard an unsaved waveform or make it count as saved.

## Debug keyboard controls

The game's Debug keyboard controls checkbox defaults on for exploratory compatibility. Off prevents new arrow actions without replacing the canvas or disabling recognition/QTE entry points. A fresh game lifecycle resets on. Keyboard play is not EMG validation or a new measured-mode input policy.

Recognition correctness now compares predicted versus requested gesture independently of obstacle success; game score remains separate. The source action mappings and classifier algorithm are unchanged.

## Researcher test/demo flag

ID generation accepts an explicit Test/demo participants flag, default false. Test IDs expose Mock/developer controls; study IDs use Ganglion. The flag persists through join/list/storage/reset/export. The disposable review launcher creates explicit test IDs, so Mock remains available without exposing it as a study participant choice. Existing participant data is not migrated by source delivery.

## Hierarchy and keyboard access

The current rehearsal uses the actual Capture/Review/Train/Game/Results controls with a prominent Practice objective and stronger panel borders. Task instructions distinguish Relax/rest from active gestures and distinguish selecting the next gesture from recording the current selection. Focused controls retain native Space activation; background Space and focused Capture Space still record.

## Current checks and limitations

Use `npm test`, `npm run typecheck`, `npm run build` and the current `npm run test:practice` entry point. Set `EMG_PRACTICE_CONDITION=threshold` for the other assignment. `tests/browser-participant-flags.mjs` covers admin generation/join, while `tests/browser-game-debug-controls.mjs` remains a focused actual-game keyboard check. Older Practice-specific browser scripts use the previous UI and are historical, not acceptance coverage for the new flow.

Browser evidence is development-server coverage with disposable fixtures, actual Mock recordings/models and no invented outcomes. Intentional fixture 503s and the inherited Recharts key warning are recorded. Production SDK runtime, full mobile game layout, physical Ganglion and model accuracy remain unvalidated; the known `exports is not defined` production blocker is not fixed by these UI changes.
