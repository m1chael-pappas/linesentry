#!/usr/bin/env python3
"""Plots an experiment run's samples, or an offline sweep, as a PNG beside its CSV.

    python3 experiments/plot.py <outDir> <run> <variant>
    python3 experiments/plot.py sweep <scenario>
    python3 experiments/plot.py compare <output.png> <runDir> [<runDir> ...]
"""

import json
import sys
from datetime import datetime
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


TASK_LINE_OFFSET = 0.08
"""Vertical distance, in tasks, between task-count lines drawn on one axis."""

TARGET_DEPTH = 100
"""Steady queue depth target from the brief, drawn as a dashed line on the queue axis."""

TARGET_LINE_HEIGHT = 0.6
"""Highest fraction of the queue axis the target line may sit at, which keeps it below the legend."""


def read_summary(out_dir: Path) -> dict:
    """Reads summary.json, or returns an empty dict when the run has none yet."""
    path = out_dir / "summary.json"
    return json.loads(path.read_text()) if path.exists() else {}


def load_window(summary: dict) -> tuple[float, float] | None:
    """Minutes into the run at which a plant-mode load started and stopped publishing, or None."""
    plant = (summary.get("measured") or {}).get("plant_load") or {}
    if not (summary.get("measured_from") and summary.get("started_at") and plant.get("seconds")):
        return None
    warmup = (
        datetime.fromisoformat(summary["measured_from"].replace("Z", "+00:00"))
        - datetime.fromisoformat(summary["started_at"].replace("Z", "+00:00"))
    ).total_seconds() / 60
    return warmup, warmup + plant["seconds"] / 60


def mark_load_window(window: tuple[float, float], upper, lower) -> None:
    """Shades the warm-up and marks where the load ends on both axes, labelling the upper one."""
    for axis in (upper, lower):
        axis.axvspan(0, window[0], color="#000", alpha=0.05, linewidth=0)
        axis.axvline(window[1], color="#555", linestyle="--", linewidth=1)
    upper.text(window[0] / 2, 0.97, "warm-up", transform=upper.get_xaxis_transform(),
               ha="center", va="top", fontsize=8, color="#555")
    upper.text(window[1], 0.35, " load ends", transform=upper.get_xaxis_transform(),
               ha="left", va="center", fontsize=8, color="#555",
               bbox={"facecolor": "white", "edgecolor": "none", "pad": 1})


def plot(out_dir: Path, run: str, variant: str) -> None:
    """Plots queue depths and running tasks for one run, titled by its directory name."""
    frame = load(out_dir)
    if frame is None:
        print(f"no samples to plot in {out_dir}")
        return
    summary = read_summary(out_dir)

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

    queues.axhline(TARGET_DEPTH, linestyle="--", linewidth=1, color="#888", label=f"target depth {TARGET_DEPTH}")
    queues.set_ylim(top=max(queues.get_ylim()[1], TARGET_DEPTH / TARGET_LINE_HEIGHT))
    queues.set_ylabel("messages waiting")
    queues.set_title(f"{out_dir.name} / {variant}")
    queues.legend(loc="upper right", frameon=False)
    queues.grid(alpha=0.25)

    highest = 1
    for column, label, colour, offset in (
        ("detection_tasks", "detection", "#c1440e", TASK_LINE_OFFSET / 2),
        ("aggregation_tasks", "aggregation", "#1f6feb", -TASK_LINE_OFFSET / 2),
    ):
        if column in frame:
            tasks.step(minutes, frame[column] + offset, where="post", linewidth=1.8, label=label, color=colour)
            highest = max(highest, frame[column].max())

    tasks.set_ylim(0, max(7, highest + 1))
    tasks.set_ylabel(f"running tasks\n(lines {TASK_LINE_OFFSET} apart)")
    tasks.legend(loc="upper right", frameon=False)

    tasks.set_xlabel("minutes into run")
    tasks.grid(alpha=0.25)

    window = load_window(summary)
    if window:
        mark_load_window(window, queues, tasks)

    figure.tight_layout()
    target = out_dir / f"{run}.png"
    figure.savefig(target, dpi=140)
    print(f"wrote {target}")

    if summary:
        measured = summary.get("measured", {})
        print(
            "peak depth",
            (measured.get("detection_queue_depth") or {}).get("max"),
            "tasks",
            (measured.get("detection_tasks") or {}).get("max"),
        )


HEARTBEAT_COLOURS = {60000: "#1f6feb", 150000: "#2a7f3f", 300000: "#c1440e", 600000: "#7d3c98"}


def plot_sweep(scenario: str) -> None:
    """Plots the offline sweep: error bound on x, four measures on y."""
    out_dir = Path("evidence") / "sweep" / scenario
    frame = pd.read_csv(out_dir / "sweep.csv")

    dual = frame[frame["filter"] == "dual-prediction"]
    deadband = frame[frame["filter"] == "deadband"]
    reference = deadband[deadband["heartbeat_ms"] == 60000].iloc[0]

    figure, axes = plt.subplots(2, 2, figsize=(12, 8))
    (rate, capacity), (fidelity, quality) = axes

    panels = [
        (rate, "forwarded_per_second", "messages per second leaving the gateway", True),
        (capacity, "machines_per_task", "machines supported per detection task", False),
        (fidelity, "reconstruction_error_max", "worst reconstruction error, sigma", False),
        (quality, "events_on_healthy_machines", "events raised on healthy machines", False),
    ]

    for axis, column, title, log in panels:
        for heartbeat, group in dual.groupby("heartbeat_ms"):
            ordered = group.sort_values("error_bound_sigma")
            axis.plot(
                ordered["error_bound_sigma"],
                ordered[column],
                marker="o",
                markersize=4,
                linewidth=1.6,
                color=HEARTBEAT_COLOURS.get(heartbeat, "#555"),
                label=f"heartbeat {heartbeat // 1000}s",
            )

        if column != "reconstruction_error_max":
            axis.axhline(
                reference[column],
                linestyle="--",
                linewidth=1.2,
                color="#888",
                label="deadband, 60s heartbeat",
            )

        if log:
            axis.set_yscale("log")
        axis.set_title(title, fontsize=10)
        axis.set_xlabel("error bound, sigma")
        axis.grid(alpha=0.25)

    fidelity.plot(
        [0, dual["error_bound_sigma"].max()],
        [0, dual["error_bound_sigma"].max()],
        linestyle=":",
        linewidth=1.2,
        color="#000",
        label="the bound itself",
    )

    rate.legend(loc="lower left", frameon=False, fontsize=8)
    fidelity.legend(loc="upper left", frameon=False, fontsize=8)
    quality.legend(loc="upper left", frameon=False, fontsize=8)

    figure.suptitle(
        f"Dual prediction sweep, {scenario} scenario, error bound against heartbeat", fontsize=12
    )
    figure.tight_layout()

    target = out_dir / f"sweep-{scenario}.png"
    figure.savefig(target, dpi=140)
    print(f"wrote {target}")


ARM_COLOURS = ["#5c5c5c", "#1f6feb", "#2a7f3f", "#c1440e", "#7d3c98"]


def plot_compare(target: Path, run_dirs: list[Path]) -> None:
    """Plots detection queue depth and running tasks for several runs of one scenario."""
    figure, (depth, tasks) = plt.subplots(
        2, 1, figsize=(11, 7), sharex=True, gridspec_kw={"height_ratios": [2, 1]}
    )

    window = None

    for index, run_dir in enumerate(run_dirs):
        frame = load(run_dir)
        if frame is None:
            continue
        summary = read_summary(run_dir)
        plant = summary["measured"].get("plant_load") or {}
        rate = plant.get("forwarded_per_second")
        label = summary["variant"] + (f", {rate:g} msg/s" if rate else "")
        colour = ARM_COLOURS[index % len(ARM_COLOURS)]
        minutes = frame["elapsed_seconds"] / 60

        window = window or load_window(summary)

        offset = (index - (len(run_dirs) - 1) / 2) * TASK_LINE_OFFSET
        depth.plot(minutes, frame["detection_depth"], linewidth=1.6, color=colour, label=label)
        tasks.step(
            minutes, frame["detection_tasks"] + offset, where="post", linewidth=1.8, color=colour, label=label
        )

    if window:
        mark_load_window(window, depth, tasks)

    depth.set_ylabel("detection queue depth")
    depth.set_title("Same plant, one arm per line: detection backlog and running tasks")
    depth.legend(loc="upper right", frameon=False, fontsize=9)
    depth.grid(alpha=0.25)

    tasks.set_ylim(0, 7)
    tasks.set_ylabel(f"detection tasks\n(lines {TASK_LINE_OFFSET} apart)")
    tasks.set_xlabel("minutes into run")
    tasks.grid(alpha=0.25)

    figure.tight_layout()
    target.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(target, dpi=140)
    print(f"wrote {target}")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "compare":
        plot_compare(Path(sys.argv[2]), [Path(d) for d in sys.argv[3:]])
        raise SystemExit(0)
    if len(sys.argv) >= 3 and sys.argv[1] == "sweep":
        plot_sweep(sys.argv[2])
    elif len(sys.argv) >= 4:
        plot(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    else:
        print("usage: plot.py <outDir> <run> <variant> | plot.py sweep <scenario>", file=sys.stderr)
        raise SystemExit(1)
