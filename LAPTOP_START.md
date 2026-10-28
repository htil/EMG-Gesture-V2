# Start the reviewed study app on your laptop

This branch contains the recent frozen-rest calibration, shared guided Practice, participant UI, positive expanded activity graph and recorder-driven status circle changes. It is a clean source snapshot: no participant records, settings database, credentials, node_modules or generated build output are included. Earlier local source history was not pushed because it also contained study records.

## Windows / PowerShell

Install Node.js 22 if Node is not already available. Open this repository folder in VS Code, then run in its terminal:

```powershell
npm.cmd ci
npm.cmd run review:practice
```

Keep that terminal open. Open the printed local address (normally `http://127.0.0.1:5214`) in Chrome or Edge. The launcher prints fresh disposable participant IDs and their assigned conditions. Use one of those IDs, not an ID from another machine. Stop with Ctrl+C; restarting generates a new disposable roster and removes the old temporary records.

All IDs start on real input. For an intentional simulated review, choose **Mock** in the test-only source controls, then **Start mock stream**. The persistent warning reminds you that this generated signal cannot respond to your physical movements. For hardware review, stay on the default real-input mode and connect your Ganglion.

macOS/Linux use `npm ci` and `npm run review:practice` instead. Package installation is required on each recipient platform; do not copy Linux node_modules into Windows.

## Scope and limits

- This is the verified development/review launcher, not a production deployment recipe.
- Tests, typecheck and build passed on Linux with cached dependencies; native Windows installation/execution and physical BLE were not observed by the agent.
- Private minified preview still fails with the inherited `exports is not defined` runtime error. Build success does not resolve that blocker.
- Planned gesture names are Wrist up / Wrist down, but gesture-set/game mapping changes are deferred. Current temporary Pinch/Squeeze/Relax defaults remain unchanged; this delivery does not claim those have been replaced.
- Real participant data belongs only on the machine running its study API. The whole `/data/` directory is ignored to prevent accidental publishing. This branch does not migrate your existing IDs or records.

The feature branch is for review; it does not merge into main. See `docs/ACTIVITY_FEEDBACK_REFINEMENT.md` for the latest UI delta and limitations.
