# Study-flow integration notes

## Branches and scope

Integrates `feature/study-activity-feedback` at `1ff6bb85d52f772c8b3f6da3c987fe0087410947` into `pranay/flow-based-ui`, starting from `ae491e78db54c59bb1a05648adc672e67a2beaf2`.

This is an integration of the existing review build, not a new study procedure or a redesign of the game/classifier.

## Changes included

- **Two wrist gestures:** Wrist up and Wrist down use distinct physical-movement identifiers. Historical Pinch/Squeeze/Relax records are not renamed into wrist examples. Rest calibration remains separate from labelled gestures.
- **Guided Practice:** three retained examples per gesture, inspection and replacement, Train, game and Results, with Practice data/models kept separate from measured work. The Practice quota does not change measured collection quotas.
- **Fixed rest calibration:** threshold derived from the original rest-envelope mean plus three population standard deviations, with readiness/activation holds and calibration invalidation on source/scope changes.
- **Collection feedback:** explicit recording/readiness status, positive activity displays with signed raw waveforms preserved, and connection/save notices.
- **Graph and Results guidance:** graph purpose and close control explained; score, recognition, Unknown and recording failures distinguished. Replay game reuses the current examples/model rather than retraining.
- **Participant/test separation:** normal participant IDs use Ganglion controls; explicitly generated test/demo IDs expose Mock/debug controls. Test data is not hardware evidence.
- **Questionnaire review files:** separate Background, Session and Final imports under `docs/questionnaires/v5/`. See that folder's README for the later inline gender-text-entry request and remaining native Qualtrics configuration.
- **Disposable review launcher and regression tests:** see `LAPTOP_START.md`. The launcher creates temporary review records and deletes them on exit; do not use it for durable participant collection.

## Existing branch behavior retained

The current runner, character/obstacle designs, configurable obstacle count and starting lives, game integration, and study API remain present. Source inspection established that destination commit `ae491e7` is an ancestor of the original implementation baseline `011e907` from which the review build was prepared.

The merge initially reported 19 conflicts because the source branch carries imported files with a different commit history. Those overlaps were resolved to the reviewed descendant implementations. The integrated tracked application source matches `1ff6bb8`; the additional differences are these integration notes/navigation and destination-only tracked data files.

Existing destination `data/` files are retained byte-for-byte. No local participant recordings, modified participant CSV, local patch, dependencies, build outputs or validation artifacts are staged as new changes. The separate working checkout at `C:\Dev\Repos\EMG-Gesture-V2` is not switched, reset or overwritten by this integration.

## Verification on the integrated checkout

Using Node 22.16.0 and the existing cached dependency installation:

- `npm test`: **108 passed, 0 failed, 0 skipped**.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `node scripts/review-practice.mjs --smoke`: passed; actual development UI and isolated API joins for both assignments, with temporary records only.

These checks do not establish a clean Windows installation, browser gameplay, live Bluetooth signal quality or participant-study readiness. The previously documented production-preview runtime issue (`exports is not defined`) is not fixed or retested by this merge; successful bundling is not production-runtime validation.

## Remaining study checks

Real-device end-to-end rehearsal, same-person cross-condition/visit handoff, shared-computer privacy, durable recording/export, native Qualtrics Preview, classroom timing, measured quotas and retry/retraining rules still require agreement and verification. The planned offline DIP context-recording proposal is not implemented here.
