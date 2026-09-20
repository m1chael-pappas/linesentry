#!/usr/bin/env python3
"""Plots one experiment run's samples as a PNG beside its CSV."""

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd


def load(out_dir: Path) -> pd.DataFrame | None:
    """Reads samples.csv, or returns None when the run produced none."""
    path = out_dir / "samples.csv"
    if not path.exists():
        return None
    frame = pd.read_csv(path)
    return frame if not frame.empty else None


def plot(out_dir: Path, run: str, variant: str) -> None:
    frame = load(out_dir)
    if frame is None:
        print(f"no samples to plot in {out_dir}")
        return

    minutes = frame["elapsed_seconds"] / 60
    figure, (queues, tasks) = plt.subplots(
        2, 1, figsize=(10, 7), sharex=True, gridspec_kw={"height_ratios": [2, 1]}
    )

    for column, label in (
        ("detection_depth", "detection"),
        ("aggregation_depth", "aggregation"),
        ("alerting_depth", "alerting"),
    ):
        if column in frame:
            queues.plot(minutes, frame[column], label=label, linewidth=1.6)

    queues.axhline(100, linestyle="--", linewidth=1, color="#888", label="target depth 100")
    queues.set_ylabel("messages waiting")
    queues.set_title(f"{run} / {variant}")
    queues.legend(loc="upper right", frameon=False)
    queues.grid(alpha=0.25)

    highest = 1
    for column, label, colour in (
        ("detection_tasks", "detection", "#c1440e"),
        ("aggregation_tasks", "aggregation", "#1f6feb"),
    ):
        if column in frame:
            tasks.step(minutes, frame[column], where="post", linewidth=1.8, label=label, color=colour)
            highest = max(highest, frame[column].max())

    tasks.set_ylim(0, max(7, highest + 1))
    tasks.set_ylabel("running tasks")
    tasks.legend(loc="upper right", frameon=False)

    tasks.set_xlabel("minutes into run")
    tasks.grid(alpha=0.25)

    figure.tight_layout()
    target = out_dir / f"{run}.png"
    figure.savefig(target, dpi=140)
    print(f"wrote {target}")

    summary_path = out_dir / "summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
        measured = summary.get("measured", {})
        print(
            "peak depth",
            (measured.get("detection_queue_depth") or {}).get("max"),
            "tasks",
            (measured.get("detection_tasks") or {}).get("max"),
        )


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("usage: plot.py <outDir> <run> <variant>", file=sys.stderr)
        raise SystemExit(1)
    plot(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
