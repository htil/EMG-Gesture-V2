# Frozen resting-reference threshold

## Scope

This delta is against the immutable `EMG-Frozen-Rest-Threshold-Baseline` snapshot, not the Git HEAD alone (the supplied baseline already includes shared-Practice work). No game mappings, classifier features, RMS/preprocessing, Ganglion parser, AB/BA design, dependency manifests or participant data are changed.

The mounted `GuidedPractice` still collects the original 10-second resting reference. It preserves original raw values, `activityEnvelope`, host timestamps and source order, including distinct equal-time objects and endpoint pairs split across renders. A successful POST **and exact GET readback** authorize a live calibration. The server recomputes and validates the submitted calibration against that reference.

Version 1: `rest-envelope-mean-plus-3-population-sd` uses Welford population variance (`M2 / count`), with threshold `mean + 3 * SD`. Stored statistics are serialized to 15 significant digits. The threshold must be positive and finite. There is no downward tuning, gesture-derived update, adaptive fallback or invented source-time grid. A constant positive reference produces SD zero and can be unusable for the detector's strictly-below-boundary rest hold; the rule is not silently changed to compensate.

## Detection and display

- Threshold requires 300ms observed continuously below the *same* envelope boundary, then 100ms continuously at/above it. A brief dip breaks onset persistence. Initial/held high and an isolated low cannot trigger/rearm.
- Tied timestamps retain all observations but cannot advance a hold. Backwards/nonfinite data and gaps over 500ms cancel/disarm the recorder. The existing resting-reference validation remains stricter (250ms maximum gap).
- The existing explicit StudySession cooldown remains 450ms, anchored to the saved endpoint. Sustained activity cannot retrigger Threshold. Button retains its manual acquisition and existing cooldown/resting gate; Relax remains separately cued manual acquisition in both methods. Default countdown is still 3000ms; zero-countdown/native/background Space paths remain.
- `firstCrossingAt` is detector evidence, not physiological onset. `triggeredAt` is the persistence-confirmation sample. The saved first point includes the configured pretrigger history; the last point/`completedAt` are actual waveform bounds. Completion waits for the next strictly later timestamp so all endpoint ties can be retained. No timestamps/raw samples are manufactured or resampled.
- The calibrated chart maps envelope `[0, 2 * threshold]` onto `[0,1]`, clipped at the top; the fixed guide is at 0.5. This mapping and clipping are explicitly labelled. The old editable normalized threshold is replaced by read-only envelope-boundary output. Display history, sensitivity and normalized references do not determine calibrated decisions.

## Scope, invalidation and recovery

The live binding is participant/experiment/session/generation/round/condition/source/channel plus a source stream epoch. Stop/start/source selection invalidates at the request, before awaited shutdown; channel changes and transport disconnection also change the epoch. Reload never restores live readiness from historical calibration. Stale asynchronous reference saves may finish archiving, but cannot authorize a new stream.

**Recalibrate resting reference** reuses the same mounted rest collector and returns to the originating capture workflow. It does not create another collector or require another rehearsal/game, and does not replace the original estimate, measured trials, model revision, replacements or results. Subsequent captures use the new revision; earlier samples keep their original revision. The actual shared Practice collector/review/Train/game remain isolated from measured datasets/models and use `/practice` archives only. A recalibration can change channel/source while retaining the rehearsal attempt: each capture carries its actual source/settings and independently validated calibration reference.

Fresh streamed resting activity can be inspected against the fixed guide, and comfortable active gestures can be checked through existing shared Practice acquisition. There is no added independent rest-verification waveform or automatic pass/fail physiological quality judgement. Failed checks prompt researcher review/repeating rest, not stronger contractions or lowering the boundary. Rest estimation never becomes a Relax training example.

## Persistence

Each new capture carries `calibration` (the complete revision/formula/statistics/scope/hold/display settings used, or explicit null when manual acquisition has no live calibration) and `firstCrossingAt`. A Threshold active capture cannot be produced without live calibration. Practice and measured sanitizers validate calibration against an immutable saved reference and reject mismatches. New calibrated measured samples also reject invalid waveforms/anchors instead of applying the legacy numeric coercion. New calibration-bearing stale generations are rejected, not acknowledged as skipped saves.

Trial checkpoints, server reconstruction/rejoin, progress archives, JSON export and sample CSV preserve calibration provenance. `samples.csv` includes `first_crossing_at`, `calibration_revision` and `calibration_json`; `waveforms.json` and `practice.json` retain full evidence. Checkpoint/progress calibration claims must match an archived sample. Existing legacy records remain readable without invented calibration. Legacy `archivalOnly` practice flags continue to denote separate practice records, not permission to mix them into measured training.

## Verification and commands

Cached prerequisites: Node 22 at `/tmp/emg-calibration-tools/node-v22.16.0-linux-x64/bin`, existing app tooling/React renderer, and external Playwright at `/root/emg-review-tools/node_modules/playwright/index.mjs`. No installs or package changes were made. A clean install/other-machine portability was not tested.

```sh
export PATH=/tmp/emg-calibration-tools/node-v22.16.0-linux-x64/bin:$PATH
npm test
npm run typecheck
npm run build -- --outDir /workspace/EMG-Frozen-Rest-Threshold-Validation/implementation/dist
EMG_MAX_GAME_RUNS=1 EMG_PRACTICE_CONDITION=button EMG_PRACTICE_EVIDENCE=<private-output> node tests/browser-real-flow.mjs
EMG_MAX_GAME_RUNS=1 EMG_PRACTICE_CONDITION=threshold EMG_PRACTICE_EVIDENCE=<private-output> node tests/browser-real-flow.mjs
EMG_PRACTICE_EVIDENCE=<private-output> node tests/browser-frozen-calibration.mjs
```

`tests/frozen-*.test.mjs` exercise actual recorder/source hooks, actual mounted GuidedPractice/StudySession, real classifier construction and the real disposable API dispatcher. Only transport/router/visual leaves are substituted where declared. Numeric replay/controlled-clock fixtures are **synthetic integration tests**, not real hardware evidence. Cases cover holds/dips/held state/cooldown, display independence, batching/ties, invalid/backwards/gapped input, no fallback, stale saves, channel/reconnect/reload, rest-only recovery preserving an actual trained model, exact readback/export and malformed/stale lineage. Existing training/finalization lifecycle regressions are retained; their mocked preparation now supplies the new calibration shape honestly.

RED/GREEN traces and browser reports are under `/workspace/EMG-Frozen-Rest-Threshold-Validation/implementation/`. Numbered 01–16 logs identify observed missing behavior and the corresponding passing slice. Additional property/regression cases characterize already-correct behavior rather than claiming artificial RED failures.

Two full actual Mock journeys per condition were run (one initial, one strengthened), each with one real game: **two game runs total per condition**, never seeded. The strengthened journeys include actual measured Pinch/Squeeze/Relax, reconnect, full-duration rest-only recalibration, reload/fresh rejoin and decoded export comparisons. They passed before final narrow cooldown-anchor, Button gate, Relax-cue and API-validation fixes; the final no-game browser regression exercises both methods with repeated full-duration references, actual captures and cued Relax on the final implementation without exceeding the game limit. Final npm gates and renderer/API regressions cover the narrow fixes. Parent should independently rerun/review before applying.

## Limits and blockers

- Browser journeys run Vite development with a private API directory and private cache. Production build compiles, but the private **minified preview fails at startup with `exports is not defined`** (Participant ID never mounts). This SDK/runtime problem is outside this delta; no production SDK repair was attempted. Do not call the build production-runtime validated.
- No physical Ganglion, BLE continuity, device-clock, EMG units, comfortable-gesture reliability or physiological onset accuracy was validated. Mock supplies its built-in synthetic activity, not Ganglion RMS.
- Ordinary reload during an unfinished rehearsal loses its in-memory rehearsal/model; measured data remains backed up/server-restorable. Reload immediately after completing Practice but before a first measured trial can still choose the baseline initial setup path. Stream reconnect/rest-only recovery does not require repeating rehearsal/game.
- Baseline AB/BA, broad acquisition/progress hardening, older legacy coercion behavior, production SDK and unrelated UI warnings remain outside scope. Existing graph `key` spread warning and deliberately injected HTTP 503s appear in browser console evidence.
- Independent fail-closed review is the parent's next step; this implementer cannot self-certify that review. No commit/push or real-checkout/data writes were made. Harnesses close only their own servers/browsers and delete disposable API data.
