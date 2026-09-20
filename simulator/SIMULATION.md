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

## Why each machine gets its own baseline

Baselines are drawn from a normal distribution once per machine at construction, so normal vibration on `press-01` is not normal vibration on `press-02`.
A single plant-wide threshold would either miss a genuinely faulty quiet machine or constantly fire on a noisy healthy one, which is the case for storing per-machine baselines in the metadata store and computing a z-score against them.

Load also wanders slowly within 0.7 to 1.3 and drives current draw, and temperature carries a 60 second sine, so the signal has structure that a naive fixed threshold would trip on.
