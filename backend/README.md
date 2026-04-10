# EMG Live Backend

Minimal Python backend that streams EMG signal points over WebSocket for the training UI.

## Endpoint

- WebSocket: `/ws/emg`
- Health: `/health`

Outgoing live message shape:

```json
{
  "timestamp": 1712760000000,
  "value": 0.72
}
```

## Setup

1. Create and activate a Python virtual environment.
2. Install dependencies:

   ```bash
   pip install -r backend/requirements.txt
   ```

3. Start server from the repository root:

   ```bash
   uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
   ```

## Configuration

Environment variables:

- `EMG_SOURCE_MODE`: `ganglion` (default) or `mock`
- `GANGLION_MAC`: optional BLE MAC address
- `GANGLION_PORT`: optional serial/BLE bridge port (for Windows often `COMx`)
- `GANGLION_CHANNEL_INDEX`: channel to stream (default `0`)
- `GANGLION_SCALE_MIN`: normalization low bound (default `-200`)
- `GANGLION_SCALE_MAX`: normalization high bound (default `200`)

## Hardware/BLE assumptions

- OpenBCI Ganglion is available and powered on.
- Host machine has BLE support and permissions.
- `pyOpenBCI` can connect to the Ganglion in your environment.

If hardware is not connected, set `EMG_SOURCE_MODE=mock` so the WebSocket still streams test data.