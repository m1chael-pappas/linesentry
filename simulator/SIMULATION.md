# Simulated plant

Spins up N machines, each with four sensors and two actuators.
Every sensor publishes one raw reading per second over MQTT.

## Running it

```
pnpm --filter @linesentry/simulator broker          # local MQTT broker, dev only
pnpm --filter @linesentry/simulator start 5 1       # 5 machines on 1 line
pnpm --filter @linesentry/simulator watch           # tail the raw stream
pnpm --filter @linesentry/simulator watch:edge      # tail the gateway output
```

Machine count and line count are positional, `node dist/index.js <machines-per-line> <lines>`.
Everything else is environment.

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | Broker to publish to |
| `SITE_ID` | `plant-01` | Site identifier in the topic and payload |
| `MACHINES` | `5` | Machines per line, overridden by the first positional argument |
| `LINES` | `1` | Production lines, overridden by the second positional argument |
| `RATE_MS` | `1000` | Raw sample period |
| `SEED` | `linesentry` | Run seed, see below |
| `MQTT_PORT` | `1883` | Port the development broker listens on |

The development broker exists so the simulator and Node-RED run without installing Mosquitto.
The deployed gateway talks to AWS IoT Core instead.

## Topics

```
<site>/<line>/<machine>/<sensor>     raw readings, published
<site>/<line>/<machine>/actuator     actuator commands, subscribed
linesentry/control                   fault injection, subscribed
```

Actuator commands are `beacon_on`, `beacon_off` and `shutdown`.
A shutdown stops that machine's readings: rpm and current go to zero, temperature cools, vibration drops to a floor.
Clearing the machine's fault also clears the shutdown.

## Faults

Injected from the keyboard, or over `linesentry/control` with `{ "target": "press-03", "fault": "bearing" }`.
A target is either a machine id or a line id, so `line-A` faults every machine on that line at once.
A null fault clears.

| Fault | What it does to the signal |
|---|---|
| `bearing` | Vibration climbs at 0.08 mm/s per second and gains intermittent spikes, temperature drifts up slowly |
| `overheat` | Temperature climbs at 0.5 C per second toward the safety limit, current rises slightly |
| `overload` | Current jumps 40 percent, rpm sags 120, vibration steps up 0.4 |
| `dropout` | Rpm collapses to roughly 200 on 30 percent of samples |

`bearing` and `overheat` ramp with fault age, so they are the two that exercise the remaining-useful-life trend fit.
`overload` and `dropout` are step changes, which is what the z-score and the fixed safety thresholds catch.

## The plant is reproducible

Every machine draws its resting values and its noise from a stream seeded by the run seed and its own machine id, so the same seed always produces the same plant.

Two properties follow, and both matter for the experiments.

A run can be repeated exactly. Two arms of an A/B comparison see identical load rather than merely similar load, so a difference in the measurements is a difference between the arms rather than between two draws of random noise.

A machine behaves the same regardless of how many machines are around it. `press-05` produces the same readings in a 5 machine run and in a 200 machine run, because its stream is keyed on its own id rather than on its position in a sequence. The ramp run can therefore grow the plant from 20 to 200 machines without the machines already running changing underneath the measurement.

It also means the metadata store can be seeded with the values a machine will actually produce. `machineBaseline` is exported and the bootstrap tool calls the same function, so the stored baseline is the machine's real resting value rather than an approximation of it.

## Why each machine gets its own baseline

Each machine's resting values are drawn from a normal distribution keyed on its own id, so normal vibration on `press-01` is not normal vibration on `press-02`.
A single plant-wide threshold would either miss a genuinely faulty quiet machine or constantly fire on a noisy healthy one, which is the case for storing per-machine baselines in the metadata store and computing a z-score against them.

The signal also carries structure that a naive fixed threshold would trip on.
Load wanders slowly between 0.7 and 1.3 and drives current draw, so current moves across several amps over a run.
Temperature carries a sine of amplitude 2 C whose period is about six minutes, since `Math.sin(now / 60000)` takes radians and so repeats every 2 pi times 60 seconds rather than every 60 seconds.

Both survive the edge gateway's averaging and smoothing, which is why the baseline spreads stored for those two sensors are much wider than their per-sample noise.
See `packages/core/DETECTION.md`.
