# Combined pre-pilot integration — engineering verification candidate

Current branch: `pranay/flow-based-ui`. This history-preserving merge includes
the reviewed integration commit `9992311` and Pranay's previous tip `24d9537`.
The application sources match the reviewed candidate; destination-only history,
documents, tests and tracked records are retained without modification.
Read **[PILOT-INTEGRATION.md](PILOT-INTEGRATION.md)** for teammate provenance,
intentional conflict resolutions, safe Windows launch instructions and remaining
readiness gates. The original `pre-pilot-20261111` rollback is preserved.

This candidate combines the safe ID-entry handling fix with John's recording-zone
visual/tutorial improvements while retaining the existing study flow and recovery.
It is **not participant-ready without actual hardware and persistence acceptance**.
A permanently rejected queued save is retained and reported, not bypassed.

---

## Historical transfer notes — not the current branch/clone instructions

The material below describes an earlier WIP transfer. Its branch names, commands
and old test totals are archival; use the current integration guide above.

# WIP capture-state transfer — NOT pilot-ready

This is an urgent **source-only WIP snapshot**, not a validated replacement release.

## Checkpoints and validation

- Local completed-work checkpoint: `8a94ac5209ae79f349bc24a89af9ff90ca5980ce` on `wip/capture-state-local-20261106`.
- Earlier software-validated local baseline: `448ea2af5b7efd3c2bd6bbd0477d722ddb7c6461`. Subsequent real-Ganglion Button testing exposed capture cancellations, so that baseline is NOT a hardware-readiness guarantee. It is not an ancestor of this source-only branch.
- The narrow repair passed its focused regressions and typecheck. The latest full suite had **449 passes / 1 failure** in the legacy P0 round-trip test. The failure involved its immediate disabled-Capture invocation and old expected context count. Test-only investigation was interrupted; it is NOT claimed resolved.
- Final repaired production-browser Button/Automatic journeys, final export/restart acceptance, native Windows/Ganglion acceptance and repaired package acceptance remain outstanding. No final acceptance is claimed even if the app builds.
- This transfer removes the hardcoded first-run admin PIN and requires a local environment variable instead. This transfer-only bootstrap change is not covered by the earlier full acceptance results.

## What this preserves

The repair covers ordered raw/React archive ownership, bounded rolling unanchored Button history, and ACK-gated cue replacement/recovery. Genuine gaps/backwards timestamps, Automatic timeout, hard limits, persistence failures and spent-ID safeguards remain intentional. The exact two-second training center, up to five seconds before/after, twenty official trials, and existing Practice/game order remain unchanged. No Practice redesign, twelve-trial reduction or unrelated game merge is included.

The snapshot deliberately has no participant records, raw recordings, fitted participant models, test datasets, tests/fixtures, exports, logs, dependencies, build output, environment files, SSH material or credential files. `game/models` contains original visual game assets, NOT fitted EMG models. The inherited local Git history contained data paths, so this branch is an **orphan source snapshot** rather than a push of that history. Do not merge it wholesale into main.

## Other Windows laptop: clone and run for engineering verification only

Use native Node.js 22 x64 and Git. Open PowerShell. Stop on any failed command; do not overwrite an existing clone or point this WIP at existing study records.

```powershell
Set-Location $env:USERPROFILE
git clone --single-branch --branch wip/capture-state-transfer-20261106 https://github.com/htil/EMG-Gesture-V2.git EMG-Capture-WIP-20261106
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location 'EMG-Capture-WIP-20261106'
git rev-parse HEAD

$pin = Read-Host 'Choose a NEW researcher PIN for this fresh local store' -AsSecureString
$env:EMG_ADMIN_PIN = [System.Net.NetworkCredential]::new('', $pin).Password
npm.cmd ci --include=dev --include=optional
if ($LASTEXITCODE -ne 0) { throw 'Install failed' }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
npm.cmd run pilot -- --production --data-dir "$env:USERPROFILE\EMG-Capture-WIP-Records-20261106" --port 5220
```

Open `http://127.0.0.1:5220/`; researcher setup is `/admin`. Keep the terminal open. Use only fresh rehearsal IDs and explicitly verify actual Ganglion versus Mock. No original participant IDs or recordings were transferred. The admin PIN is entered locally, not stored in Git; the local record store retains its settings. On restart select the same record directory. Do not paste credentials into chat.

This source-only branch omits automated tests and review/demo launchers to comply with the no-test-datasets transfer requirement; `npm test` is not provided here. Regression sources and detailed evidence remain in the isolated original workspace/local checkpoint, not published as study data.

## Security and readiness

Known dependency advisories remain unresolved, including a Vite preview-server issue. Functional checks are not security clearance. Keep production bound to loopback, no tunnels or LAN exposure, no unrelated browsing/dev servers during a bounded rehearsal, restrict/back up records and stop afterward. Do not use this WIP for participant collection based on this transfer alone.

Existing validated Windows folders, their native dependencies/builds, and all original records are unchanged. No merge to main is authorized or performed.
