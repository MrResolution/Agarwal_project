"""Built-in protocols and the seeded trial-plan generator.

A plan is fully determined by (protocol, params, seed), so any block can be regenerated and
repeated exactly. That is the assessment-repeatability rule from the research doc.
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from ..contract.messages import TrialSpec
from .layout import DEFAULT_N_TARGETS, default_layout


@dataclass(frozen=True)
class Protocol:
    key: str
    name: str
    kind: str  # "assessment" | "training"
    description: str
    n_trials: int = 20
    foreperiod_ms: tuple[int, int] = (1000, 2500)
    window_ms: int = 1500
    iti_ms: int = 600
    nogo_ratio: float = 0.0
    targets: str = "all"  # "all" | "centre" | "peripheral" (every target outside the central band)
    skills: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


PROTOCOLS: dict[str, Protocol] = {
    p.key: p
    for p in (
        Protocol("simple_rt", "Simple reaction", "assessment",
                 "One central target, known in advance. Measures pure visuomotor reaction speed.",
                 n_trials=20, targets="centre", skills=("reaction",)),
        Protocol("choice_rt", "Choice reaction", "assessment",
                 "Any target may light. Measures speed of locating and reaching the correct target.",
                 n_trials=24, skills=("reaction", "coordination")),
        Protocol("go_nogo", "Go / No-Go", "assessment",
                 "Hit green, ignore red. Measures response inhibition together with speed.",
                 n_trials=30, nogo_ratio=0.25, skills=("inhibition", "reaction")),
        Protocol("peripheral", "Peripheral response", "training",
                 "Outer targets only while fixating the centre. Peripheral-response training, "
                 "not a fixation-controlled visual-field test.",
                 n_trials=24, targets="peripheral", skills=("peripheral", "reaction")),
        Protocol("speed_drill", "Speed drill", "training",
                 "Short foreperiods and a tight response window to push reaction speed.",
                 n_trials=30, foreperiod_ms=(600, 1400), window_ms=900, iti_ms=400,
                 skills=("reaction", "coordination")),
    )
}


def protocol_with_overrides(key: str, params: dict[str, Any] | None) -> Protocol:
    if key not in PROTOCOLS:
        raise KeyError(f"unknown protocol '{key}'")
    p = PROTOCOLS[key]
    if not params:
        return p
    allowed = {"n_trials", "foreperiod_ms", "window_ms", "iti_ms", "nogo_ratio", "targets"}
    clean = {k: v for k, v in params.items() if k in allowed}
    if "foreperiod_ms" in clean:
        lo, hi = clean["foreperiod_ms"]
        clean["foreperiod_ms"] = (int(lo), int(hi))
    return replace(p, **clean)


def eligible_targets(p: Protocol, n_targets: int) -> list[str]:
    layout = default_layout(n_targets)
    if p.targets == "centre":
        centre = min(layout.values(), key=lambda t: abs(t.angle_deg))
        return [centre.target_id]
    if p.targets == "peripheral":
        # Outer targets: everything outside the central band (mid + peripheral). With 6 targets
        # the >= 45 deg band alone would leave only T1 and T6.
        return [t.target_id for t in layout.values() if t.band != "central"] or list(layout)
    return list(layout)


def generate_plan(p: Protocol, seed: int, n_targets: int = DEFAULT_N_TARGETS) -> list[TrialSpec]:
    """Balanced, seeded sequence: each eligible target appears equally often (as far as the
    trial count allows) and never more than 3 times in a row; no-go trials are spread evenly."""
    rng = random.Random(seed)
    targets = eligible_targets(p, n_targets)
    seq = (targets * (p.n_trials // len(targets) + 1))[: p.n_trials]
    for _ in range(200):
        rng.shuffle(seq)
        if len(targets) == 1 or all(len(set(seq[i:i + 4])) > 1 for i in range(len(seq) - 3)):
            break
    n_nogo = round(p.n_trials * p.nogo_ratio)
    nogo_idx = set(rng.sample(range(1, p.n_trials), n_nogo)) if n_nogo else set()  # never the first trial
    return [
        TrialSpec(
            trial_no=i,
            target_id=tid,
            colour="red" if i in nogo_idx else "green",
            is_nogo=i in nogo_idx,
            foreperiod_ms=rng.randint(*p.foreperiod_ms),
            window_ms=p.window_ms,
            iti_ms=p.iti_ms,
        )
        for i, tid in enumerate(seq)
    ]
