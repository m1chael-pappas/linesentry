# Detection tuning

Three rules judge every window. All three run, and a window can trip more than one.

## Baseline spread

`BASELINE_SD` is the standard deviation of the smoothed window value, not of a raw sensor sample.

Detection sees a value after it has been averaged over 10 samples and EWMA smoothed at alpha 0.3. Averaging 10 samples reduces noise by the square root of 10. The EWMA reduces what remains by roughly half again. A vibration sample with a spread of 0.15 mm/s reaches detection with a spread near 0.02.

Using the sample spread would put every ordinary window tens of standard deviations from its baseline, and the z-score rule would fire constantly.

What remains in the smoothed signal is the systematic movement the simulator produces: a sine on temperature with amplitude 2 C and a period of about 6 minutes, and a bounded random walk on load that moves current across several amps. Both survive the averaging and smoothing.

| Sensor | Per-sample spread | Stored spread | Dominant source |
|---|---|---|---|
| vibration | 0.15 | 0.08 | Residual noise |
| temperature | 0.3 | 1.5 | The 2 C sine |
| current | 0.2 | 2.0 | The load random walk |
| rpm | 8 | 10 | Residual noise |

I checked these against a run with no faults, which produced zero events over several minutes at 5 machines. If a no-fault run raises an event, the spread for that sensor is too tight.

## Alarm direction

`ALARM_DIRECTION` sets which side of the baseline the z-score rule alarms on. The other side is ignored.

A press running cooler, quieter or drawing less current than usual is not failing. Rpm is the exception, where the dangerous direction is downward, because rpm drops under a jam or a failing drive.

This matters most after a shutdown. A stopped machine reads zero rpm, zero current and almost no vibration at the same time. Against a running baseline that looks like a severe anomaly on three sensors. Without directional alarming, stopping a machine raises new alerts about the machine being stopped.

Zero rpm is handled by the stopped-machine check in the detection service, which requires both zero rpm and zero current so a seized motor still alerts.

## Commanded stops

Directional alarming and the stopped-machine check remove most of the noise after a shutdown, but not all of it.

When a machine is switched off, rpm does not reach zero in the signal immediately. The gateway averages over 10 seconds and then smooths, so for several windows the rpm reading is partway down. A window during spin-down reads as rpm falling fast, which is also what a seizing drive reads as. The stopped-machine check reports the machine as still turning, because by the signal it is.

No rule that reads only the readings can separate the two cases. The difference is whether a stop was ordered.

Detection records that decision. When it raises a `threshold-breach` it also writes a machine-level entry in the alert store. Every window is checked against that entry before it is judged. Once a machine has been ordered to stop, its sensors raise no further events for the rest of the episode. The machine is stopped and a technician has a work order for it.

The entry is cached for a few seconds rather than read per window, because it changes at most once per fault. It lives in the shared store so it still applies when another task handles the next window.

## Alert episodes

A fault lasts many windows. Without suppression, a two minute overheat raises an event and opens a work order every 10 seconds.

Alert episodes are tracked per machine and sensor. An event is raised only when it opens a new episode or escalates a running one. Escalation means a higher rank:

```
rank = type * 10 + severity

type      anomaly 0   predicted-failure 1   threshold-breach 2
severity  low 0       medium 1              high 2
```

Type dominates severity, so a threshold breach outranks an anomaly of any severity. Suppressing everything after the first event would keep the count down, but would also suppress the breach that stops the machine.

One overheat fault produces about four events:

| Step | Event |
|---|---|
| Opens episode | `anomaly` medium, z-score around 3 |
| Escalates | `anomaly` high, z-score past 6 |
| Escalates | `predicted-failure`, trend reaching the limit inside the horizon |
| Escalates | `threshold-breach`, machine stops |

The episode expires after `ALERT_EPISODE_MS`. A fault that recurs later opens a new episode.

## Remaining useful life

The trend rule fits a least-squares line through the last `HISTORY_WINDOWS` smoothed values and computes when that line reaches the safety threshold. It reports a prediction when the crossing falls inside `RUL_HORIZON_MS` and the value has not already crossed. A value past the limit is a breach for the threshold rule to report.

Fewer points than the configured history produces no prediction. This is what makes the history buffer disposable. A detection task that restarts with an empty buffer loses predictions for a few minutes. The threshold and z-score rules judge each window on its own and are unaffected.
