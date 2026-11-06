# Activity-feedback refinement

## Approved scope

- Expanded saved-sample Graph defaults to the same existing 75 ms display-only RMS envelope as the preview, with a zero-based nonnegative activity axis, a clean line and plain-language explanation. The signed raw trace, point inspector, table and original CSV remain in a collapsed Researcher details section. No waveform, source timestamp, export or classifier preprocessing changes.
- The circle uses the exact labels Rest, Ready, Recording, Error and Movement, plus a short nearby instruction and the existing recording-progress ring. For automatic active captures, Ready comes from the actual recorder's completed resting hold; Movement covers its ongoing activation confirmation. Button Ready means Capture is available; its countdown is Movement. A completed gesture also uses Movement with an explicit instruction to choose the next movement/review examples. Disarmed setup never claims Ready.
- All IDs, including test IDs, start on live input. Mock requires explicit selection, is still offered only for test participants, and displays a persistent warning explaining that it cannot respond to physical movement.
- Changing the setup source preserves the current guidance step while existing epoch/scope guards invalidate pending calibration. The graph-orientation highlight targets the activity plot rather than the entire enlarged graph/status/raw panel, avoiding overlap at the tested smaller viewport.

## Unchanged / deferred

The participant's planned gestures are wrist flexion and extension, provisionally Wrist down and Wrist up with a palm-down posture. This pass does **not** rename Pinch/Squeeze IDs, remove the temporary Relax class, implement gesture configuration, alter game mappings or add a third gesture/level. Existing Relax capture remains a separately cued Button exception until that gesture-set work is agreed and wired end-to-end.

Fixed calibration formula, boundary/display mapping, 300 ms return-to-rest and 100 ms activation holds, countdown/window defaults, acquisition, calibration lineage, Practice/measured separation, model construction and game behavior are unchanged. The recorder addition only publishes a read-only projection of its existing holds.

## Verification and limitations

- Test-first RED/GREEN evidence is retained outside the candidate in `/workspace/EMG-Activity-Feedback-Validation`: graph transform/raw preservation, explicit source selection, actual hook readiness, mounted circle transitions, and source-switch guide-state regression.
- Full automated suite: 101 passing, zero failing. Typecheck and private build pass using the existing cached Linux dependencies; no installs or clean-install portability claim.
- Actual Chromium journeys exercise both Button and Threshold using researcher-created disposable API records and the actual Mock source, full resting duration and existing Practice/recorder/Train/game/Results/API/export stages. No readiness, waveforms, models or outcomes are seeded. First attempts exposed the source-change welcome reset before any game; corrected reruns passed. The harness now explicitly selects Mock and expects live input after a fresh rejoin.
- Real mounted layout checks pass at 1440×1000 and 1024×768, including actual separately cued resting captures in both conditions. New status/banner initially exposed a smaller-viewport guidance overlap; anchoring the activity plot fixed it.
- Private minified preview still fails before Participant ID mounts with the inherited `exports is not defined` runtime error. Passing compilation and development journeys are **not** production-runtime readiness.
- No physical Ganglion, electrode-placement, wrist-movement separability or physiological validation. No changes to real participant data, no commits/pushes, no dependency installs.
