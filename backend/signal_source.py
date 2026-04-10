from __future__ import annotations

import math
import random
import threading
import time
from dataclasses import dataclass
from queue import Empty, Queue
from typing import Any, Callable, Optional


@dataclass(frozen=True)
class SignalPoint:
    timestamp: float
    value: float


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


class BaseSignalSource:
    """Threaded signal source that pushes normalized signal points to a queue."""

    def __init__(self) -> None:
        self._queue: Queue[SignalPoint] = Queue(maxsize=2000)
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None

    def get_point(self, timeout: float = 1.0) -> Optional[SignalPoint]:
        try:
            return self._queue.get(timeout=timeout)
        except Empty:
            return None

    def _publish(self, value: float) -> None:
        point = SignalPoint(timestamp=time.time() * 1000.0, value=_clamp(value))
        try:
            self._queue.put_nowait(point)
        except Exception:
            # If the queue is full, drop old points to keep stream freshness.
            try:
                _ = self._queue.get_nowait()
                self._queue.put_nowait(point)
            except Exception:
                pass

    def _run(self) -> None:
        raise NotImplementedError


class MockSignalSource(BaseSignalSource):
    def _run(self) -> None:
        while not self._stop_event.is_set():
            t = time.time()
            wave = 0.55 + math.sin(t * 6.0) * 0.2
            noise = (random.random() - 0.5) * 0.08
            self._publish(wave + noise)
            time.sleep(0.05)


class GanglionSignalSource(BaseSignalSource):
    """
    Streams one Ganglion channel and normalizes it to [0, 1].

    This adapter expects pyOpenBCI and OpenBCIGanglion support.
    """

    def __init__(
        self,
        ganglion_mac: Optional[str],
        ganglion_port: Optional[str],
        channel_index: int,
        scale_min: float,
        scale_max: float,
    ) -> None:
        super().__init__()
        self._ganglion_mac = ganglion_mac
        self._ganglion_port = ganglion_port
        self._channel_index = channel_index
        self._scale_min = scale_min
        self._scale_max = scale_max
        self._board: Any = None

    def _normalize(self, raw_value: float) -> float:
        if self._scale_max <= self._scale_min:
            return 0.0
        return (raw_value - self._scale_min) / (self._scale_max - self._scale_min)

    def _extract_channel_value(self, sample: Any) -> Optional[float]:
        possible_attrs = ("channels_data", "channel_data", "channels", "data")
        values: Any = None
        for attr in possible_attrs:
            if hasattr(sample, attr):
                values = getattr(sample, attr)
                break

        if values is None:
            return None

        try:
            raw_value = float(values[self._channel_index])
            return raw_value
        except (TypeError, ValueError, IndexError):
            return None

    def _on_sample(self, sample: Any) -> None:
        raw_value = self._extract_channel_value(sample)
        if raw_value is None:
            return
        self._publish(self._normalize(raw_value))

    def _run(self) -> None:
        try:
            from pyOpenBCI import OpenBCIGanglion  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "pyOpenBCI is required for live Ganglion mode. "
                "Install dependencies from backend/requirements.txt"
            ) from exc

        kwargs: dict[str, Any] = {}
        if self._ganglion_mac:
            kwargs["mac"] = self._ganglion_mac
        if self._ganglion_port:
            kwargs["port"] = self._ganglion_port

        self._board = OpenBCIGanglion(**kwargs)

        def _stream_callback(sample: Any) -> None:
            if self._stop_event.is_set():
                return
            self._on_sample(sample)

        try:
            self._board.start_stream(_stream_callback)
        finally:
            try:
                if self._board is not None:
                    self._board.stop_stream()
            except Exception:
                pass


def create_signal_source(
    mode: str,
    ganglion_mac: Optional[str],
    ganglion_port: Optional[str],
    channel_index: int,
    scale_min: float,
    scale_max: float,
) -> BaseSignalSource:
    if mode.lower() == "mock":
        return MockSignalSource()
    return GanglionSignalSource(
        ganglion_mac=ganglion_mac,
        ganglion_port=ganglion_port,
        channel_index=channel_index,
        scale_min=scale_min,
        scale_max=scale_max,
    )