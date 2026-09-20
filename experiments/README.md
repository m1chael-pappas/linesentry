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
| `samples.csv` | Queue depths, detection task count and stored row count, sampled every 10 seconds |
| `summary.json` | Latency percentiles, peak and steady queue depth, task range, measured against the targets |
| `<run>.png` | Queue depth and task count over the run |
| `simulator.log` | Simulator output, including the fault injections |

`VARIANT` sets the variant label and defaults to `baseline`. Metrics are dimensioned by it, so two arms of a comparison do not mix.

After each run, `evidence.mjs` rewrites `evidence/EVIDENCE.md` with one row per run and the measured numbers filled in.

## The five scenarios

| Run | Setup | Duration |
|---|---|---|
| `baseline` | 20 machines, no faults | 10 min |
| `ramp` | 20 to 200 machines in steps, 5 min each | 30 min |
| `burst` | 200 machines, overheat across a full line of 50 | 12 min |
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

## Offline sweep

```
node experiments/sweep.mjs steady
node experiments/sweep.mjs faults
MACHINES=50 LINES=4 SECONDS=1800 node experiments/sweep.mjs faults
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
