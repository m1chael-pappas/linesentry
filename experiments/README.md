# Experiments

Scripts that run a scenario unattended and report measured numbers.

## Running a scenario

```
./experiments/run.sh baseline
./experiments/run.sh ramp
./experiments/run.sh burst
./experiments/run.sh scale-in
./experiments/run.sh failure
```

Each run writes into `evidence/<variant>/<run>/`:

| File | Contents |
|---|---|
| `samples.csv` | Queue depths and task counts, sampled every 10 seconds. The stored row count only with `COUNT_ROWS=1`, since it scans the whole table each sample |
| `summary.json` | Latency percentiles, peak and steady queue depth, task range, measured against the targets |
| `<run>.png` | Queue depth and task count over the run |
| `simulator.log` | Simulator output, including the fault injections |
| `faults.jsonl` | One line per fault injection, which `collect.mjs` matches events against |
| `load.log` | Load generator output, for `overload` and `scale` |

`VARIANT` sets the variant label and defaults to `baseline`. Metrics are dimensioned by it, so two arms of a comparison do not mix.

After each run, `evidence.mjs` rewrites `evidence/EVIDENCE.md` with one row per run and the measured numbers filled in.

## The five scenarios

| Run | Setup | Duration |
|---|---|---|
| `baseline` | 20 machines, no faults | 10 min |
| `ramp` | 20 to 200 machines in steps, 5 min each | 30 min |
| `burst` | 200 machines, overheat across a full line of 50 | 12 min |
| `scale` | 6,000 machines through the arm's filter, published at plant scale | 15 min |
| `scale-in` | Clear the fault and wait for the task count to return to 1 | 20 min |
| `failure` | Stop a detection task mid-burst | 11 min |

The scale-in run is 20 minutes rather than 10. Target tracking's scale-in alarm requires 15 one-minute datapoints, so scale-in cannot happen sooner. See `infra/SCALING.md`.

## Failure run

```
./experiments/failure-run.sh
```

Faults a whole line, stops the detection container mid-burst, restarts it, and checks four things once the queues have drained.

Every window the ingest bridge forwarded should have become a row in the time-series store. The script counts both and reports the difference, which should be zero.

All three queues should drain to empty and all three dead letter queues should stay empty. A message on a dead letter queue means a handler failed three times, which is a different problem from a task stopping.

Every event id should be distinct. This holds by construction, because the id is a hash of the machine, the sensor and the window start, and the write is conditional on that id not existing.

The conditional write rejection counts are reported too. A run where the detection task was stopped mid-burst and nothing was ever rejected has not tested redelivery. A zero there is a reason to check `MessagesRedelivered` rather than a pass.

Stopping the container is what makes this a real test. The messages the task held were never acknowledged, so SQS makes them visible again after the visibility timeout and another task picks them up.

Environment overrides: `MACHINES`, `LINE`, `FAULT`, `SETTLE_SECONDS`, `SQS_HOST`, `API_HOST`, `DYNAMO_HOST`.

## Plant scale

```
VARIANT=baseline ./experiments/run.sh scale
VARIANT=dual-prediction-b0.5-hb600 BOUND=0.5 HEARTBEAT_S=600 ./experiments/run.sh scale
```

The `scale` scenario runs `load.mjs plant`, which builds the seeded plant, runs every reading through the TypeScript edge chain and the arm's filter, and publishes only what that filter forwards to the ingest topic. `edge.test.ts` proves that chain equal to the deployed Node-RED flow, so the generator stands in for many gateways on one plant. Every arm sees the same plant, so the message rate and the task count differ only by the filter.

`overload` publishes identical synthetic windows at a fixed rate. Every arm receives the same rate, so it measures the cloud side's capacity and cannot show a filter.

Machines join across the first minute and nothing is published for the first 90 seconds. Otherwise every key makes its first forward in the same second, and that burst alone triggers scale-out in every arm. `SCALE_MACHINES`, `LOAD_SECONDS` and `WARMUP_SECONDS` override the defaults of 6,000, 600 and 90.

The metadata table needs a row for every generated machine, or detection skips its windows as unknown: `SEED_MACHINES=50 SEED_LINES=120 make seed`.

Task-minutes, summed from Container Insights `RunningTaskCount`, are the measure to compare. Target tracking holds backlog per task at 50, so a sawtooth of forwards landing on every 10 second boundary sends it to the task ceiling in one step whenever backlog builds, and the peak task count can match across arms that need very different capacity.

### Per-task capacity

`collect.mjs` reports `saturated_throughput`, the messages per second one detection task processed in minutes where it never ran out of work. A minute counts when every harness sample of the detection queue in it, taken about every 10 seconds, read above 500. The CloudWatch depth metric cannot decide this: SQS pushes one `ApproximateNumberOfMessagesVisible` datapoint a minute, so its minute `Minimum` is a single reading, and a burst on a 10 second boundary can put it above 500 in a minute the task spent mostly idle.

The task count for each minute is the mean ECS `runningCount` across the same samples. Container Insights `RunningTaskCount` can still read 1 in the minute a service scales from one task to six. `one_task_per_second_p50` repeats the median over the minutes in which every sample saw exactly one task. Pinning detection to one task with `DETECTION_MAX_TASKS=1` turns a `scale` run into a probe of that capacity:

```
make arm VARIANT=deadband-hb60-pinned DETECTION_STRATEGY=baseline DETECTION_MAX_TASKS=1
VARIANT=deadband-hb60-pinned HEARTBEAT_S=60 SCALE_MACHINES=2500 LOAD_SECONDS=240 RUN_TAG=m2500 ./experiments/run.sh scale
```

A probe that keeps up drains its queue within seconds of the load stopping, which `load_end.drained_after_seconds` records. One that falls behind takes minutes, and its backlogged minutes measure the task's capacity at that arm's traffic.

`saturated_throughput.cpu_ms_per_message` divides the detection service's CPU time in the same minutes, from Container Insights `CpuUtilized` summed over tasks at 1024 units per vCPU, by the messages it processed in them. A detection task has 256 CPU units at the default `task_cpu`, and a backlogged task runs at 250 or more, so this is the cost that sets one task's capacity. Only backlogged minutes count, because an idle task still spends CPU polling an empty queue.

`metadata_reads_per_message` and `alert_reads_per_message` divide each table's `ConsumedReadCapacityUnits` by the messages detection processed, at two reads per unit for eventually consistent reads of items under 4 KB. Detection caches metadata for 60 seconds and stop state for 5 seconds per task, so these ratios rise as each task sees a given machine less often, whether because the machine sends less or because more tasks share its messages.

## CloudWatch graphs

```
python3 experiments/plot-cloudwatch.py widgets evidence/<variant>/<run>
```

Asks CloudWatch to render its own graphs for a run's time window and variant through `GetMetricWidgetImage`: queue depth against running tasks, messages received against windows judged, and gateway-to-row latency. They are the graphs the CloudWatch console draws for the same query, written beside the run's summary.

Detection series are drawn last, so where a detection and an aggregation line hold the same value, as the task counts do on a run that never scales, the detection line is the one visible. A widget is 85 px wide per minute of the run, between 600 and 1000 px. CloudWatch labels ticks to the minute and spaces them by width, so a nine-minute run drawn 1000 px wide repeats every label.

## Offline sweep

```
node experiments/sweep.mjs steady
node experiments/sweep.mjs faults
MACHINES=50 LINES=4 SWEEP_SECONDS=1800 SEED=seed-2 node experiments/sweep.mjs faults
python3 experiments/plot.py sweep faults
```

The sweep replays the seeded plant through the edge chain and the detection rules for every error bound and heartbeat in one pass, with no AWS account. The plant is deterministic in its seed, so the message rate and detection quality curve is a property of the simulator and the gateway rather than of the cloud.

One aggregator and one smoother produce each window once, and every arm judges that same window. The arms therefore see identical load by construction rather than by running them one after another and hoping the load repeated.

`steady` injects no faults and measures message rate. `faults` injects 16 faults across 16 machines, one of each type in rotation, staggered 30 seconds apart and cleared after 240 seconds.

Per arm it writes:

| Measure | How it is taken |
|---|---|
| Forwarded rate | Per second, per machine and per sensor type |
| Consumer coverage | Forwarded plus reconstructed, over the windows in closed gaps |
| Reconstruction error | `abs(real - reconstructed)` against the truth series, in standard deviations |
| Faults matched | First event on a sensor the fault moves, inside the fault's window |
| Detection delay | Windows between injection and the matching event |
| Events on healthy machines | Events on a machine with no fault active at that window |
| Windows evaluated | Forwarded plus reconstructed, which is the work, against messages, which is the cost |
| Machines per task | Messages one task sustains, divided by the forwarded rate per machine |

A gap travels on the message that closes it, so the windows after a key's last forward have not been reconstructed yet. Coverage is measured over closed gaps only, and counting them would report an end-of-run artefact as a loss.

The harness does not model the shutdown the alerting service issues on a threshold breach, so a faulted machine keeps producing readings for the whole fault. It also skips the stopped-machine check, which exists to handle spin-down after that shutdown.

Results go to `evidence/sweep/<scenario>/`, and `evidence.mjs` folds them into `evidence/EVIDENCE.md`.

## Reading the metrics locally

Each service writes embedded metric format documents to `local/emf/<service>.jsonl`. `summarise-emf.mjs` reads those and prints totals and percentiles per service and variant.

```
node experiments/summarise-emf.mjs local/emf/*.jsonl
node experiments/summarise-emf.mjs --json local/emf/*.jsonl
```

Millisecond metrics are reported as count, p50, p95 and max. Gauges are reported as last and maximum value. Everything else is totalled.

The same documents are what CloudWatch Logs extracts metrics from on AWS, where they go to stdout instead of a file. See `packages/core/METRICS.md`.
