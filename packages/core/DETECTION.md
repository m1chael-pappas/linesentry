# Detection tuning

Three rules judge every window, and all three run. A window can trip more than one, and a fault usually trips several as it develops.

## Why the baseline spread is so wide

`BASELINE_SD` is the expected spread of the **smoothed window value**, not of a raw sensor sample, and the two differ by more than an order of magnitude.

By the time detection sees a number it has been averaged over ten samples and then EWMA smoothed at alpha 0.3. Averaging ten samples cuts the noise by the square root of ten, and the EWMA cuts what is left by roughly another half. A vibration sample with a sample spread of 0.15 mm/s arrives at detection with a spread nearer 0.02.

If the stored spread were the sample spread, every ordinary window would sit tens of standard deviations from its baseline and the z-score rule would fire constantly.

What actually remains in the smoothed signal is not noise at all. It is the systematic movement the simulator puts in on purpose: a slow sine on temperature with an amplitude of 2 C and a period of about six minutes, and a bounded random walk on load between 0.7 and 1.3 that drives current across a range of several amps. Those swings survive both the averaging and the smoothing, and they are what the stored spread has to cover.

That is why the numbers look large next to the per-sample noise:

| Sensor | Per-sample spread | Stored spread | What dominates |
|---|---|---|---|
| vibration | 0.15 | 0.08 | Residual noise |
| temperature | 0.3 | 1.5 | The 2 C sine |
| current | 0.2 | 2.0 | The load random walk |
| rpm | 8 | 10 | Residual noise |

These were checked against a run with no faults injected, which produced zero events over several minutes at five machines. A no-fault run that raises anything means the spread for that sensor is too tight.

## Only one tail of each sensor is dangerous

`ALARM_DIRECTION` says which side of the baseline is worth alarming about, and the z-score rule ignores the other side.

A press running cooler, quieter or drawing less current than usual is not failing. Alarming on both tails produces noise that buries the real thing. Rpm is the exception, where the dangerous direction is downward, because rpm sags under a jam or a failing drive.

This matters most immediately after a shutdown. A stopped machine reads zero rpm, zero current and almost no vibration all at once, which against a running baseline looks like a severe anomaly on three sensors at the same moment. Without directional alarming, stopping a machine because of one fault instantly raises fresh alerts about the machine having been stopped, and the system alarms about its own remediation.

The remaining case, zero rpm, is handled separately by the stopped-machine check in the detection service, which requires both zero rpm and zero current so that a seized motor still alerts.

## A commanded stop has to be written down

Directional alarming and the stopped-machine check together remove most of the noise that follows a shutdown, but not all of it, and the leftover case is worth spelling out because it cannot be fixed by looking harder at the readings.

When a machine is switched off, its rpm does not drop to zero in the signal immediately. The edge gateway averages over ten seconds and then smooths, so for the next few windows the rpm reading is somewhere on the way down. A window part way through a spin-down reads as rpm falling fast, which is exactly what a seizing drive reads as. The stopped-machine check correctly reports the machine as still turning, because by the signal it still is.

No rule that reads only the readings can separate the two. The difference is not in the data, it is in whether anyone ordered the machine to stop.

So detection writes that decision down. When it raises a `threshold-breach`, it also records a machine-level entry in the alert store, and every window is checked against that entry before it is judged. Once a machine has been ordered to stop, its sensors stop raising events for the rest of the episode, which is correct anyway: the machine is stopped and a technician already has a work order for it.

The entry is cached for a few seconds rather than read per window, since it changes at most once per fault. It lives in the shared store rather than in memory so that it still applies when another task picks up the next window, or when the task that wrote it has been replaced.

## One fault, one episode

A fault lasts for many windows. Without suppression, a two minute overheat raises an event and opens a work order every ten seconds, which at two hundred machines would bury a technician.

An alert episode is tracked per machine and sensor. An event is only raised when it opens a new episode or escalates a running one, where escalation means a higher rank:

```
rank = type * 10 + severity

type      anomaly 0   predicted-failure 1   threshold-breach 2
severity  low 0       medium 1              high 2
```

Type dominates severity, so a threshold breach always outranks an anomaly however severe the anomaly looked. That ordering is deliberate. Suppressing everything after the first event would keep the count down but would also suppress the breach that stops the machine, which is the one event that must never be dropped.

A single overheat fault therefore produces roughly four events as it develops, rather than one per window:

| | Event |
|---|---|
| Opens episode | `anomaly` medium, z-score around 3 |
| Escalates | `anomaly` high, z-score past 6 |
| Escalates | `predicted-failure`, trend reaching the limit inside the horizon |
| Escalates | `threshold-breach`, and the machine stops |

The episode expires after `ALERT_EPISODE_MS`, so a fault that recurs later is a new episode rather than being suppressed forever.

## Remaining useful life

The trend rule fits a least-squares line through the last `HISTORY_WINDOWS` smoothed values and asks when that line reaches the safety threshold. It reports a prediction when the crossing falls inside `RUL_HORIZON_MS` and the value has not already crossed, since a value past the limit is a breach for the threshold rule to report rather than something to predict.

Fewer points than the configured history means no prediction at all. That is what lets the history buffer be disposable: a detection task that restarts with an empty buffer loses predictions for a few minutes and nothing else, because the threshold and z-score rules judge each window on its own.
