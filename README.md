
  # Untitled

  This is a code bundle for Untitled. The original project is available at https://www.figma.com/design/YVxBgDxmVFyUo5HtENqhnv/Untitled.

  ## Running the code

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

  ## Signal source modes

  The training screen supports two signal sources:

  - Mock mode: local generated EMG data
  - Connect Ganglion: direct OpenBCI Ganglion BLE stream through Chrome/Edge Web Bluetooth

  ## Run frontend

  Install and start:

  ```bash
  npm i
  npm run dev
  ```

  To stay in mock mode, leave the UI toggle on `Mock`.

  To test direct Ganglion BLE, open the frontend on `localhost` in Chrome or Edge, then click `Connect Ganglion` and choose the board from the browser Bluetooth prompt. The current live path displays a normalized packet-level preview signal for UI testing, not calibrated microvolt values yet.

  ## Optional backend

  Backend instructions are in `backend/README.md`. The current frontend live button uses direct browser BLE instead of the backend WebSocket.

  Quick start:

  ```bash
  pip install -r backend/requirements.txt
  uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
  ```

  Then switch the UI toggle to `Live`.
  
