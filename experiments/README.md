# Experiments

Scripts that run a scenario unattended and report measured numbers.

## Failure run

```
./experiments/failure-run.sh
```

Faults a whole line, kills the detection container mid-burst, restarts it, and then checks four things once the queues have drained.

**Nothing was lost.** Every window the ingest bridge forwarded should have become a row in the time-series store. The script counts both and reports the difference, which should be zero.

**Nothing is stuck.** All three queues should drain to empty, and all three dead letter queues should stay empty. A message on a dead letter queue means a handler failed three times rather than that a task died, which is a different problem.

**No event was raised twice.** Every event id should be distinct. This is guaranteed by construction rather than by luck, since the id is a hash of the machine, the sensor and the window start, and the write is conditional on that id not already existing.

**Redeliveries actually happened.** The conditional write rejection counts are reported too. A run where the detection task was killed mid-burst and nothing was ever rejected has not really tested redelivery, it has just been lucky about timing, so a zero here is a reason to look harder rather than a pass.

Killing the container is what makes this a real test. The messages the task held were never acknowledged, so SQS makes them visible again after the visibility timeout and a different task picks them up, judging windows that may already have been judged.

Environment overrides: `MACHINES`, `LINE`, `FAULT`, `SETTLE_SECONDS`, `SQS_HOST`, `API_HOST`, `DYNAMO_HOST`.
