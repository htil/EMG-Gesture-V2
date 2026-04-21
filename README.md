
# EMG Gesture V2

EMG Gesture V2 is an EMG training and data-collection interface for testing gesture capture with either mock data or a live OpenBCI Ganglion signal.

## Run the app

From the project root:

```bash
npm install
npm run dev
```

Vite will print a local URL, usually:

```bash
http://127.0.0.1:5173/
```

Open that URL in your browser.

## Modes

The app supports two signal source modes:

- `Mock`: generated EMG-like signal for UI and recording-flow testing
- `Connect Ganglion`: live OpenBCI Ganglion signal through browser BLE

## How to use Mock mode

1. Run:

```bash
npm run dev
```

2. Open the local Vite URL
3. Leave the source toggle on `Mock`
4. The graph will animate with generated signal data
5. You can test threshold-triggered recording behavior without hardware

## How to use Live Ganglion mode

1. Run:

```bash
npm run dev
```

2. Open the local Vite URL in **Chrome or Edge**
3. Click `Connect Ganglion`
4. Choose the Ganglion from the browser Bluetooth picker
5. The live signal should begin streaming into the chart

Notes:

- Web Bluetooth works best from `localhost` / `127.0.0.1`
- Use Chrome or Edge, not Firefox
- Make sure the Ganglion is not already connected to another app

## Useful commands

Start dev server:

```bash
npm run dev
```

Build production bundle:

```bash
npm run build
```

## Backend

There is a `backend/` folder in the repo, but the current frontend live signal path uses direct browser BLE for the Ganglion. You do not need the backend running for the current UI workflow.

  ## TODO

  - [ ] Fixed-length recording flow: use threshold crossing only to trigger the start of capture, then record for a set duration so every sample has the same time window.
  - [ ] Add a visible recording progress indicator, such as a loading bar or circular timer, while a fixed-length sample is being captured.
  - [ ] Save richer sample metadata with each recording, including gesture name, timestamp, threshold used, duration, and peak signal value.
  - [ ] Add a short cooldown between recordings so one long contraction does not accidentally create multiple samples.
  - [ ] Improve sample quality rules so captures can be labeled more accurately as good, weak, noisy, or too short.
  - [ ] Add a calibration flow for rest baseline and threshold suggestion before recording starts.
  - [ ] Let the user clear all samples for the current gesture and restart collection quickly.
  - [ ] Export recorded samples for training, ideally as JSON or CSV.
  - [ ] Persist collected samples locally so refreshes do not wipe out a session.
  - [ ] Add a lightweight session summary showing how many usable samples exist per gesture.
  - [ ] Make the live status panel more explicit about source, connection state, and whether capture is idle, armed, or recording.
  - [ ] Tune the UI around one-channel EMG collection so the workflow feels intentional rather than generic.
  
