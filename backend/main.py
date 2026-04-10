from __future__ import annotations

import os
from contextlib import suppress

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from backend.signal_source import create_signal_source

app = FastAPI(title="EMG Live Stream Backend")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/emg")
async def emg_stream(websocket: WebSocket) -> None:
    await websocket.accept()

    source_mode = os.getenv("EMG_SOURCE_MODE", "ganglion")
    ganglion_mac = os.getenv("GANGLION_MAC")
    ganglion_port = os.getenv("GANGLION_PORT")
    channel_index = int(os.getenv("GANGLION_CHANNEL_INDEX", "0"))
    scale_min = float(os.getenv("GANGLION_SCALE_MIN", "-200.0"))
    scale_max = float(os.getenv("GANGLION_SCALE_MAX", "200.0"))

    source = create_signal_source(
        mode=source_mode,
        ganglion_mac=ganglion_mac,
        ganglion_port=ganglion_port,
        channel_index=channel_index,
        scale_min=scale_min,
        scale_max=scale_max,
    )

    try:
        source.start()

        while True:
            point = source.get_point(timeout=1.0)
            if point is None:
                continue

            await websocket.send_json({
                "timestamp": point.timestamp,
                "value": point.value,
            })

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        with suppress(Exception):
            await websocket.send_json({
                "error": str(exc),
            })
    finally:
        source.stop()
        with suppress(Exception):
            await websocket.close()