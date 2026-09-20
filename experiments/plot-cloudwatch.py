#!/usr/bin/env python3
"""Plots the LineSentry metrics CloudWatch extracted from the service logs.

    python3 experiments/plot-cloudwatch.py [hours] [output.png]

Reads the CloudWatch metrics rather than the harness CSVs, so the figure shows
what CloudWatch itself holds after extracting the embedded metric format lines.
"""

import json
import subprocess
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


if __name__ == "__main__":
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 3
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("evidence/cloudwatch-metrics.png")
    target.parent.mkdir(parents=True, exist_ok=True)
    plot(hours, target)
