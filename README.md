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
| `services/aggregation` | Writes each window to the time-series store |
| `services/detection` | Z-score, safety thresholds and remaining useful life, raises events |
| `services/alerting` | Technician notification, actuator command, work order |
| `services/api` | Read-only endpoints over events, time-series and work orders |
| `infra/` | Terraform, and the AWS capability probe |
| `experiments/` | Unattended experiment runs |
| `evidence/` | Measured results, one directory per variant and run |

## Running it

Requires Node 22, pnpm 10.24.0 and Docker.

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

Service images all come from the one root `Dockerfile`, which takes the service as a build argument:

```
docker build --build-arg SERVICE=detection -t linesentry-detection:dev .
```

## Swappable pipeline stages

The edge filter and the detection algorithm are each selected by name at startup from a registry.
Adding an alternative is a new file and one `register` call, with no change to the services or the queue plumbing.
This exists so a research-derived pipeline variant can be run against this one on identical load and compared directly.
`packages/core/STRATEGIES.md` sets out what an implementation has to honour.

## Toolchain notes

pnpm only, no `npm install` or `npx` anywhere.
Use `pnpm dlx` in place of `npx`.

The pnpm version is pinned in the root `packageManager` field.
Docker images activate it through corepack.
Local development uses a standalone pnpm of the same version, because the corepack bundled with Node 22.13.1 ships a stale npm signing key list and rejects current pnpm releases ([nodejs/corepack#612](https://github.com/nodejs/corepack/issues/612)).

`pnpm deploy` runs with `--legacy` in the Dockerfile.
From pnpm 10 the default deploy path requires `inject-workspace-packages=true`, which replaces the symlink from a service to `@linesentry/core` with a copied directory, so an edit to core would not be visible to a service until the next install.
Keeping the legacy deploy confines that tradeoff to the image build and leaves local development on symlinks.
