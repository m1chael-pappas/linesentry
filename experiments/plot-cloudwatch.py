#!/usr/bin/env python3
"""Plots the LineSentry metrics CloudWatch extracted from the service logs.

    python3 experiments/plot-cloudwatch.py [hours] [output.png]
    python3 experiments/plot-cloudwatch.py widgets <run-dir>

Reads the CloudWatch metrics rather than the harness CSVs, so the figure shows
what CloudWatch itself holds after extracting the embedded metric format lines.

`widgets` asks CloudWatch to render its own graphs for one run's time window
and variant, through GetMetricWidgetImage, and writes them beside the run's
summary. They are the graphs the CloudWatch console draws for the same query.
"""

import base64
import json
import subprocess
import time
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

NAMESPACE = "LineSentry"
REGION = "us-east-1"

LATENCIES = [
    ("WindowStoredLatency", "aggregation", "Average", "#1f6feb"),
    ("IngestToDetectLatency", "detection", "Average", "#c1440e"),
    ("DetectToAlertLatency", "alerting", "Average", "#2a7f3f"),
]

COUNTS = [
    ("MessagesProcessed", "aggregation", "Sum", "#1f6feb"),
    ("EventsWritten", "detection", "Sum", "#c1440e"),
    ("AlertsRaised", "alerting", "Sum", "#2a7f3f"),
]


def fetch(metric: str, service: str, stat: str, start: datetime, end: datetime, period: int):
    """Returns (timestamps, values) for one metric, sorted oldest first."""
    query = [
        {
            "Id": "m1",
            "MetricStat": {
                "Metric": {
                    "Namespace": NAMESPACE,
                    "MetricName": metric,
                    "Dimensions": [
                        {"Name": "service", "Value": service},
                        {"Name": "variant", "Value": "baseline"},
                    ],
                },
                "Period": period,
                "Stat": stat,
            },
            "ReturnData": True,
        }
    ]

    result = subprocess.run(
        [
            "aws", "cloudwatch", "get-metric-data",
            "--start-time", start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "--end-time", end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "--metric-data-queries", json.dumps(query),
            "--region", REGION,
            "--output", "json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        print(f"  {metric}/{service}: call failed", file=sys.stderr)
        return [], []

    data = json.loads(result.stdout)["MetricDataResults"][0]
    pairs = sorted(zip(data["Timestamps"], data["Values"]))
    if not pairs:
        return [], []

    stamps = [datetime.fromisoformat(t.replace("Z", "+00:00")) for t, _ in pairs]
    return stamps, [v for _, v in pairs]


def plot(hours: float, output: Path) -> None:
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    period = 60 if hours <= 3 else 300

    figure, (top, bottom) = plt.subplots(2, 1, figsize=(11, 7), sharex=True)

    for metric, service, stat, colour in LATENCIES:
        stamps, values = fetch(metric, service, stat, start, end, period)
        if not stamps:
            continue
        top.plot(stamps, values, label=f"{metric} ({service})", linewidth=1.5, color=colour)
        print(f"  {metric:<24} {len(values):>4} datapoints, max {max(values):.0f} ms")

    top.set_yscale("log")
    top.set_ylabel("latency ms, log scale")
    top.set_title(f"LineSentry metrics extracted by CloudWatch, last {hours:g} hours")
    top.legend(loc="upper left", frameon=False, fontsize=9)
    top.grid(alpha=0.25, which="both")

    for metric, service, stat, colour in COUNTS:
        stamps, values = fetch(metric, service, stat, start, end, period)
        if not stamps:
            continue
        bottom.plot(stamps, values, label=f"{metric} ({service})", linewidth=1.5, color=colour)
        print(f"  {metric:<24} {len(values):>4} datapoints, total {sum(values):.0f}")

    bottom.set_ylabel(f"count per {period}s")
    bottom.set_xlabel("time, UTC")
    bottom.legend(loc="upper left", frameon=False, fontsize=9)
    bottom.grid(alpha=0.25)
    bottom.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=timezone.utc))

    figure.tight_layout()
    figure.savefig(output, dpi=140)
    print(f"wrote {output}")


CLUSTER = "linesentry"


def render_widget(widget: dict, target: Path) -> bool:
    """Writes the PNG CloudWatch renders for `widget` to `target`."""
    result = subprocess.run(
        [
            "aws", "cloudwatch", "get-metric-widget-image",
            "--metric-widget", json.dumps(widget),
            "--output-format", "png",
            "--region", REGION,
            "--output", "json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(f"  {target.name}: {result.stderr.strip()[:200]}", file=sys.stderr)
        return False

    target.write_bytes(base64.b64decode(json.loads(result.stdout)["MetricWidgetImage"]))
    print(f"wrote {target}")
    return True


def widget_width(start: str, end: str) -> int:
    """Pixel width for a widget spanning `start` to `end`: 85 px per minute, clamped to 600 to 1000."""
    minutes = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 60
    return int(min(1000, max(600, 85 * minutes)))


def run_widgets(run_dir: Path) -> None:
    """Renders the CloudWatch graphs for the run whose summary is in `run_dir`."""
    summary = json.loads((run_dir / "summary.json").read_text())
    variant = summary["variant"]
    start, end = summary["started_at"], summary["finished_at"]
    title = f"{run_dir.name} / {variant}"

    base = {
        "width": widget_width(start, end),
        "height": 400,
        "start": start,
        "end": end,
        "region": REGION,
        "period": 60,
        "timezone": time.strftime("%z"),
    }

    queues_and_tasks = {
        **base,
        "title": f"Queue depth and running tasks, {title}",
        "metrics": [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "linesentry-aggregation-q",
             {"label": "aggregation queue", "stat": "Maximum", "color": "#ff7f0e"}],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "linesentry-detection-q",
             {"label": "detection queue", "stat": "Maximum", "color": "#1f77b4"}],
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", CLUSTER, "ServiceName",
             "linesentry-aggregation",
             {"label": "aggregation tasks", "stat": "Maximum", "yAxis": "right", "color": "#d62728"}],
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", CLUSTER, "ServiceName",
             "linesentry-detection",
             {"label": "detection tasks", "stat": "Maximum", "yAxis": "right", "color": "#2ca02c"}],
        ],
        "yAxis": {"left": {"label": "messages waiting", "min": 0}, "right": {"label": "tasks", "min": 0}},
    }

    work_against_messages = {
        **base,
        "title": f"Messages received and windows judged, {title}",
        "metrics": [
            [NAMESPACE, "MessagesProcessed", "service", "detection", "variant", variant,
             {"label": "messages received", "stat": "Sum"}],
            [NAMESPACE, "WindowsEvaluated", "service", "detection", "variant", variant,
             {"label": "windows judged", "stat": "Sum"}],
            [NAMESPACE, "WindowsReconstructed", "service", "detection", "variant", variant,
             {"label": "windows reconstructed", "stat": "Sum"}],
        ],
        "yAxis": {"left": {"label": "per minute", "min": 0}},
    }

    latency = {
        **base,
        "title": f"Gateway to stored row latency, {title}",
        "metrics": [
            [NAMESPACE, "WindowStoredLatency", "service", "aggregation", "variant", variant,
             {"label": "p50", "stat": "p50"}],
            [NAMESPACE, "WindowStoredLatency", "service", "aggregation", "variant", variant,
             {"label": "p95", "stat": "p95"}],
        ],
        "yAxis": {"left": {"label": "ms", "min": 0}},
    }

    for name, widget in (
        ("cw-queues-tasks.png", queues_and_tasks),
        ("cw-messages-windows.png", work_against_messages),
        ("cw-latency.png", latency),
    ):
        render_widget(widget, run_dir / name)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "widgets":
        run_widgets(Path(sys.argv[2]))
        raise SystemExit(0)

    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 3
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("evidence/cloudwatch-metrics.png")
    target.parent.mkdir(parents=True, exist_ok=True)
    plot(hours, target)
