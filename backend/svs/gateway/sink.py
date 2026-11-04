"""Buffered Parquet writer for high-rate sensor streams.

Samples are never inserted row-by-row into SQL. They are buffered per
``(station, stream, sensor, boot)`` and flushed as immutable Parquet "part" files:

    {root}/{station}/{stream}/{sensor}/{boot_id}/part-{first_t_hub_us}-{rand}.parquet

Read a whole stream back with ``pyarrow.dataset.dataset(path)`` or :func:`read_stream`.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

from ..contract.messages import StreamBatch

Key = tuple[str, str, str, str]  # station, stream, sensor, boot_id


@dataclass
class _Buffer:
    channels: list[str]
    started: float = field(default_factory=time.monotonic)
    t_hub: list[int] = field(default_factory=list)
    t_server: list[int | None] = field(default_factory=list)
    seq: list[int] = field(default_factory=list)
    quality: list[str] = field(default_factory=list)
    values: list[list[float]] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.t_hub)


class ParquetSink:
    def __init__(self, root: Path, flush_rows: int = 5000, flush_s: float = 5.0) -> None:
        self.root = Path(root)
        self.flush_rows, self.flush_s = flush_rows, flush_s
        self._buffers: dict[Key, _Buffer] = {}
        self._lock = threading.Lock()
        self.rows_written = 0
        self.files_written = 0

    def add_batch(self, station: str, batch: StreamBatch, t0_server_us: int | None, clock_quality: str) -> None:
        key = (station, batch.stream, batch.sensor_id, batch.boot_id)
        with self._lock:
            buf = self._buffers.get(key)
            if buf is not None and buf.channels != batch.channels:
                self._flush_locked(key)  # channel layout changed (firmware update): new file
                buf = None
            if buf is None:
                buf = self._buffers[key] = _Buffer(channels=list(batch.channels))
            for i, row in enumerate(batch.samples):
                offset = i * batch.dt_us
                buf.t_hub.append(batch.t0_us + offset)
                buf.t_server.append(None if t0_server_us is None else t0_server_us + offset)
                buf.seq.append(batch.seq)
                buf.quality.append(clock_quality)
                buf.values.append(row)
            if len(buf) >= self.flush_rows:
                self._flush_locked(key)

    def flush_due(self) -> int:
        """Flush buffers that are old enough. Returns number of files written."""
        now = time.monotonic()
        written = 0
        with self._lock:
            for key, buf in list(self._buffers.items()):
                if len(buf) and now - buf.started >= self.flush_s:
                    written += self._flush_locked(key)
        return written

    def flush_all(self) -> int:
        with self._lock:
            return sum(self._flush_locked(k) for k in list(self._buffers))

    def _flush_locked(self, key: Key) -> int:
        buf = self._buffers.pop(key, None)
        if not buf:
            return 0
        station, stream, sensor, boot = key
        cols: dict[str, pa.Array] = {
            "t_hub_us": pa.array(buf.t_hub, pa.int64()),
            "t_server_us": pa.array(buf.t_server, pa.int64()),
            "seq": pa.array(buf.seq, pa.int64()),
            "clock_quality": pa.array(buf.quality, pa.string()).dictionary_encode(),
        }
        for j, name in enumerate(buf.channels):
            cols[name] = pa.array([row[j] for row in buf.values], pa.float32())
        table = pa.table(cols)
        out_dir = self.root / station / stream / sensor / boot
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"part-{buf.t_hub[0]:016d}-{uuid.uuid4().hex[:6]}.parquet"
        pq.write_table(table, path, compression="zstd")
        self.rows_written += len(buf)
        self.files_written += 1
        return 1


def read_stream(root: Path, station: str, stream: str, sensor: str, boot_id: str | None = None) -> pa.Table:
    """Load a stored stream, sorted by hub time. ``boot_id=None`` reads every boot."""
    base = Path(root) / station / stream / sensor
    paths = sorted((base / boot_id if boot_id else base).rglob("*.parquet"))
    if not paths:
        return pa.table({})
    table = ds.dataset(paths, format="parquet").to_table()
    return table.sort_by("t_hub_us")
