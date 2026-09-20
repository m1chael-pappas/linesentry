# Simulated plant

Runs N machines, each with four sensors and two actuators. Every sensor publishes one raw reading per second over MQTT.

## Running it

```
pnpm --filter @linesentry/simulator broker          # local MQTT broker, dev only
pnpm --filter @linesentry/simulator start 5 1       # 5 machines on 1 line
pnpm --filter @linesentry/simulator watch           # tail the raw stream
pnpm --filter @linesentry/simulator watch:edge      # tail the gateway output
```

Machine count and line count are positional: `node dist/index.js <machines-per-line> <lines>`. Everything else is environment.

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | Broker to publish to |
| `SITE_ID` | `plant-01` | Site identifier in the topic and payload |
| `MACHINES` | `5` | Machines per line, overridden by the first positional argument |
| `LINES` | `1` | Production lines, overridden by the second positional argument |
| `RATE_MS` | `1000` | Raw sample period |
| `SEED` | `linesentry` | Run seed |
| `MQTT_PORT` | `1883` | Port the development broker listens on |

The development broker lets the simulator and Node-RED run without installing Mosquitto. The deployed gateway talks to AWS IoT Core.

## Topics

```
<site>/<line>/<machine>/<sensor>     raw readings, published
<site>/<line>/<machine>/actuator     actuator commands, subscribed
linesentry/control                   fault injection, subscribed
```

Actuator commands are `beacon_on`, `beacon_off` and `shutdown`. A shutdown sets rpm and current to zero, cools the temperature and drops vibration to a floor. Clearing the machine's fault also clears the shutdown.

## Faults

Injected from the keyboard, or over `linesentry/control` with `{ "target": "press-03", "fault": "bearing" }`. A target is a machine id or a line id, so `line-A` faults every machine on that line. A null fault clears.

| Fault | Effect on the signal |
|---|---|
| `bearing` | Vibration climbs at 0.08 mm/s per second with intermittent spikes, temperature drifts up slowly |
| `overheat` | Temperature climbs at 0.5 C per second toward the safety limit, current rises slightly |
| `overload` | Current rises 40 percent, rpm drops 120, vibration steps up 0.4 |
| `dropout` | Rpm falls to about 200 on 30 percent of samples |

`bearing` and `overheat` ramp with fault age, so they exercise the remaining-useful-life trend fit. `overload` and `dropout` are step changes, which the z-score and the fixed safety thresholds catch.

## Reproducibility

Every machine draws its resting values and its noise from a stream seeded by the run seed and its own machine id. The same seed produces the same plant.

A run can be repeated exactly, so two arms of an A/B comparison see identical load. A difference in the measurements is then a difference between the arms rather than between two draws of noise.

A machine behaves the same regardless of how many machines surround it. `press-05` produces the same readings in a 5 machine run and a 200 machine run, because its stream is keyed on its own id rather than its position in a sequence. The ramp run can grow the plant from 20 to 200 machines without changing the machines already running.

The metadata store can also be seeded with the values a machine will produce. `machineBaseline` is exported and the bootstrap tool calls the same function.

## Per-machine baselines

Each machine's resting values are drawn from a normal distribution keyed on its own id, so normal vibration on `press-01` is not normal vibration on `press-02`. A single plant-wide threshold would either miss a faulty quiet machine or fire constantly on a noisy healthy one. This is why baselines are stored per machine and detection computes a z-score against them.

The signal carries structure a fixed threshold would trip on. Load moves slowly between 0.7 and 1.3 and drives current draw, so current moves across several amps over a run. Temperature carries a sine of amplitude 2 C with a period of about 6 minutes, because `Math.sin(now / 60000)` takes radians and repeats every 2 pi times 60 seconds.

Both survive the edge gateway's averaging and smoothing, which is why the stored baseline spreads for those two sensors are wider than their per-sample noise. See `packages/core/DETECTION.md`.
