# Participant guidance and capture display

This refinement builds on local commit `73930e2` without changing the detector, recording timings, preprocessing, class membership, game mappings or classifier.

## Participant experience

- Practice guidance sits beside its highlighted target. Wide graph targets use a wider instruction card so text and its action fit beside the graph on desktop/laptop screens.
- The graph-orientation instruction contains the sole **I’m ready to rest** action. Participants no longer have to find another button above the graph.
- Practice uses one main instruction source. The older Practice objective instructions are removed; the measured capture explanation is hidden during guided Practice.
- Instructions use short action sentences and the supplied current/next gesture names. The rest-role instruction also uses its supplied label instead of the literal name Relax.
- The resting-setup banner shows a short status and **Redo resting setup**. Formula, revision and hold metadata remain available in closed researcher details for test/demo IDs.
- Researcher-created test/demo IDs retain window/pretrigger/countdown controls and channel selection inside closed **Researcher controls**. Ordinary participant IDs never receive that section.
- Signal values, sample rate and routine capture notices are in closed **Show signal details**. Connection failures have an expanded, visible error outside that section.
- Space on details summaries retains its native expand/collapse action and does not start a manual capture. Capture-button/background Space behavior is preserved.

The user still needs to judge wording/placement during real use. Passing geometry tests is not proof of novice usability.

## Scope limits

This does not add a full Admin gesture-set editor. Guidance reads supplied labels, but the broader application still uses its existing gesture identities/configuration. Arbitrary changes to class count/membership and historical-record semantics need their own implementation. Relax acquisition changes, new practice repetition counts, graph scaling changes and Results redesign remain separate decisions. No data is relabelled from later settings.

Physical Ganglion, physiological validity and minified SDK startup are not validated by these UI tests. The existing production `exports is not defined` blocker was not repaired.

## Verification

Evidence is under `/workspace/EMG-Participant-UX-Refinement-Validation`:

- Numbered RED/GREEN logs: actual guide placement, co-located graph action, collapsed controls, single instruction/banner language, summary Space, visible connection failures.
- `full-final.log`, `types-final.log`, `build-final.log`: full npm gates.
- `browser-threshold/` and `browser-button-retry/`: actual full Mock workflows, real capture/review/delete/replace/Train/game/Results/measured checks. The first Button run failed before a game during ongoing development/HMR and remains as failed evidence, not a pass. An unchanged-source rerun passed without modifying detector tolerances.
- `browser-layout/` and `browser-layout-wide/`: real 1024×768 overlap reproductions. `browser-layout-final/`: passing adjacent-card/viewport checks at 1440×1000 and 1024×768, no game runs.
- `recovery-tests.log`, `recovery-types.log`, `recovery-build.log`: October 28 recovery gates passed (94 tests, typecheck, private build). The build still reports inherited SDK eval and chunk-size warnings; compilation is not production runtime approval.
- `08-rest-guide-red.log` and `08-rest-guide-green.log`: reproduced and fixed a review finding where selecting the rest-role gesture before the introduction incorrectly promised automatic capture. Both conditions now say to keep resting and press Capture; countdown/recording keep the resting instruction. Configured-label and actual-manual-mode coverage also passes.
- `recovery-browser/report.json`: fresh mounted Chromium checks passed at both viewport sizes and through actual separately cued rest captures in Button and Threshold, with no new game runs and disposable API storage cleaned up.
- Native Windows execution and live hardware are distinct from Linux/Mock browser verification. Independent review must pass before local delivery.

## Local review

Deliver only the reviewed delta to the user's normal local branch, preserving participant data and unrelated CRLF changes. No pushes are part of this refinement.

```powershell
cd C:\Dev\Repos\EMG-Gesture-V2
git switch feature/guided-practice-onboarding
npm.cmd run review:practice
```

Open `http://127.0.0.1:5214` and use the fresh Threshold or Button ID printed by the launcher. This command uses disposable data and generates new IDs each run; it does not use the original study records or the obsolete ZIP review folder.
