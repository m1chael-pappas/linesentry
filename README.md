# LineSentry

A predictive maintenance pipeline for a simulated manufacturing site, built to be measurably scalable rather than just described as scalable.

Sensors on simulated machines publish once per second over MQTT.
An edge gateway aggregates them into 10 second windows and forwards only what has changed.
The cloud side detects faults, raises events, alerts a technician and shuts the machine down, with each stage decoupled through a queue so it can scale on its own.

## Pipeline

```
simulator                     edge gateway (Node-RED)
  4 sensors x N machines  -->   10s window -> EWMA -> deadband
  1 reading/sec                          |
                                         v
                                    AWS IoT Core
                                         |  topic rule adds ingest_ts
                                         v
                              SNS linesentry-windows
                                 |                  |
                    SQS aggregation-q          SQS detection-q
                           |                          |
                    aggregation svc            detection svc  (autoscaled)
                           |                          |
                    time-series store          events store
                                                      |
                                           SNS linesentry-events
                                                      |
                                              SQS alerting-q
                                                      |
                                                alerting svc
                                                 |    |    |
                                    technician SNS   MQTT actuator   work orders
```

Services never call each other.
Every producer and consumer is decoupled through the bus, which is what allows the detection service to scale on queue backlog without anything else changing.

Only the detection service autoscales, and that is deliberate: it is the stage whose cost grows with fault load rather than with machine count, so it is the one where scaling is worth demonstrating.

## Layout

| Path | What is in it |
|---|---|
| `simulator/` | Machines, sensors, actuators and injectable faults over MQTT |
| `edge/` | Node-RED flow doing window aggregation, EWMA smoothing and deadband filtering |
| `packages/core` | Message contracts, strategy registries and runtime helpers shared by every service |
| `services/ingest` | Local stand-in for the IoT Core topic rule, bridging MQTT to the queues |
| `services/aggregation` | Writes each window to the time-series store |
| `services/detection` | Z-score, safety thresholds and remaining useful life, raises events |
| `services/alerting` | Technician notification, actuator command, work order |
| `services/api` | Read-only endpoints over events, time-series and work orders |
| `tools/bootstrap` | Creates the tables and seeds per-machine baselines |
| `local/` | Mosquitto and ElasticMQ configuration for the local stack |
| `infra/` | Terraform, and the AWS capability probe |
| `experiments/` | Unattended experiment runs |
| `evidence/` | Measured results, one directory per variant and run |

## Running it

Requires Node 24, pnpm 12.5.1 and Docker.
The Node version is pinned in `.node-version`, and pnpm comes from the `packageManager` field through corepack, so `corepack enable` is the only setup step.

```
pnpm install
pnpm build
pnpm test
```

The simulator and a development MQTT broker run without any AWS account or Docker:

```
pnpm --filter @linesentry/simulator broker
pnpm --filter @linesentry/simulator start 5 1
pnpm --filter @linesentry/simulator watch
```

See `simulator/SIMULATION.md` for the fault model and the topic layout.

### The whole pipeline, locally

`docker compose up` runs the entire pipeline with no AWS account: Mosquitto, ElasticMQ in place of SQS, DynamoDB Local, Node-RED running the edge flow, and the five services.

```
docker compose up -d
pnpm --filter @linesentry/simulator start 5 1
```

Then inject a fault and watch it come out the other end:

```
pnpm --filter @linesentry/simulator fault press-03 overheat
curl -s localhost:3000/events | jq
curl -s localhost:3000/workorders | jq
```

The api is read-only and listens on port 3000.

| Endpoint | What it returns |
|---|---|
| `GET /machines` | Every machine with its open event count and worst severity |
| `GET /events?limit=` | Events, newest first |
| `POST /events/:id/ack` | Acknowledges one event |
| `GET /machines/:id/timeseries?sensor=&from=&to=` | Stored windows for one sensor |
| `GET /workorders?limit=` | Open maintenance jobs |

Service images all come from the one root `Dockerfile`, which takes the service as a build argument:

```
docker build --build-arg SERVICE=detection -t linesentry-detection:dev .
```

### What runs where

Postgres is not in the local stack even though the brief lists it. The capability probe found that this account can describe RDS instances but not create them, so work orders live in DynamoDB, and a Postgres container locally would mean maintaining an adapter that can never be deployed. `infra/CAPABILITIES.md` records the probe output.

## Swappable pipeline stages

The edge filter and the detection algorithm are each selected by name at startup from a registry.
Adding an alternative is a new file and one `register` call, with no change to the services or the queue plumbing.
This exists so a research-derived pipeline variant can be run against this one on identical load and compared directly.
`packages/core/STRATEGIES.md` sets out what an implementation has to honour, and `packages/core/DETECTION.md` explains how the rules that ship here are tuned and why one fault produces a handful of events rather than one per window.

## Toolchain notes

pnpm only, no `npm install` or `npx` anywhere.
Use `pnpm dlx` in place of `npx`.

The pnpm version is pinned in the root `packageManager` field and both local development and the Docker images activate it through corepack, so there is one pnpm version and one place it is declared.

Node is pinned to 24, the Active LTS line, in `.node-version`.
Node 26 becomes LTS on 28 October 2026 and moving to it is a one line change in that file and in the `NODE_IMAGE` build argument.

Versions across the workspace come from the `catalog` in `pnpm-workspace.yaml` rather than being repeated in each package.
