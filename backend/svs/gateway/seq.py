"""Per-channel sequence tracking: duplicate suppression and lost-message (gap) detection."""

from __future__ import annotations

from collections import OrderedDict


def to_ranges(seqs: list[int]) -> list[tuple[int, int]]:
    """[3, 4, 5, 9] -> [(3, 5), (9, 9)]"""
    out: list[tuple[int, int]] = []
    for s in sorted(seqs):
        if out and s == out[-1][1] + 1:
            out[-1] = (out[-1][0], s)
        else:
            out.append((s, s))
    return out


class SeqTracker:
    """Tracks one ``(device_id, boot_id, channel)`` sequence.

    ``accept(seq)`` classifies each arriving message:

    * ``"new"``       first time seen - process it
    * ``"duplicate"`` already seen (MQTT QoS1 redelivery, fault) - drop it
    * ``"recovered"`` was reported lost, now arrived late (e.g. SD-card backfill) - process it

    ``check_gaps(now)`` reports seqs that stayed missing longer than ``grace_s``. A gap at the
    very end of a stream cannot be seen this way; stall detection (no data at all) covers that.
    """

    MAX_WINDOW = 20_000  # beyond this the tracker gives up on enumerating holes individually

    def __init__(self, grace_s: float = 2.0) -> None:
        self.grace_s = grace_s
        self.floor: int | None = None  # every seq <= floor is settled (seen or declared lost)
        self.high: int | None = None
        self._seen: set[int] = set()  # seen seqs above floor
        self._pending: dict[int, float] = {}  # missing seq -> when we first noticed
        self._lost: OrderedDict[int, None] = OrderedDict()  # declared lost (bounded)
        self.counts = {"new": 0, "duplicate": 0, "recovered": 0, "lost": 0}

    def accept(self, seq: int) -> str:
        if self.floor is None:
            # Start tracking at the first seq we see: a gateway that (re)starts mid-stream
            # must not report everything before it as lost.
            self.floor = seq - 1
            self.high = seq - 1
        if seq in self._lost:
            del self._lost[seq]
            self.counts["recovered"] += 1
            self.counts["lost"] -= 1
            return "recovered"
        if seq <= self.floor or seq in self._seen:
            self.counts["duplicate"] += 1
            return "duplicate"
        self._seen.add(seq)
        self._pending.pop(seq, None)
        if seq > self.high:
            self.high = seq
        self._compact()
        self.counts["new"] += 1
        return "new"

    def _compact(self) -> None:
        while self.floor + 1 in self._seen:
            self.floor += 1
            self._seen.discard(self.floor)

    def check_gaps(self, now: float) -> list[tuple[int, int]]:
        if self.floor is None or self.high is None or self.high - self.floor <= 1:
            return []
        if self.high - self.floor > self.MAX_WINDOW:
            # Catastrophic loss; settle everything below high as one range.
            missing = [s for s in range(self.floor + 1, self.high) if s not in self._seen]
            return self._declare_lost(missing)
        expired = []
        for s in range(self.floor + 1, self.high):
            if s in self._seen:
                continue
            first = self._pending.setdefault(s, now)
            if now - first >= self.grace_s:
                expired.append(s)
        return self._declare_lost(expired)

    def _declare_lost(self, seqs: list[int]) -> list[tuple[int, int]]:
        if not seqs:
            return []
        for s in seqs:
            self._pending.pop(s, None)
            self._lost[s] = None
            self._seen.add(s)  # settled, so the floor can advance past it
        while len(self._lost) > 50_000:
            self._lost.popitem(last=False)
        self.counts["lost"] += len(seqs)
        self._compact()
        return to_ranges(seqs)
