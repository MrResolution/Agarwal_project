"""Analysis engine: trial scoring, summary statistics, movement onset and balance metrics.

Everything here is a pure function of stored data (events + Parquet streams), so results can
always be recomputed and are tested against known answers from the simulator.
"""
