# Metrics

Every service emits CloudWatch Embedded Metric Format documents, one JSON object per line, in the namespace `LineSentry`.

On AWS those lines go to stdout, where the ECS log driver forwards them to CloudWatch Logs and CloudWatch extracts the metrics. Locally they go to the file named by `EMF_FILE`, which the experiment harness parses. The code path is identical in both cases, so a metric that works locally works deployed.

## Dimensions

Every metric carries two dimensions, `service` and `variant`.

`variant` comes from the `VARIANT` environment variable and defaults to `baseline`. It exists so two arms of the same experiment can be graphed against each other without their numbers being mixed. Every metric from a run of the research-derived pipeline lands under a different variant label than the same metric from this one.

Nothing else is a dimension. Dimensioning by machine id would create a separate CloudWatch metric per machine, which at 200 machines multiplies the custom metric bill by 200 and answers no question the experiments ask.

## The latency chain

Four timestamps are stamped as a reading moves through the pipeline, and all four travel with the message.

| Stamp | Set by | At |
|---|---|---|
| `edge_ts` | Edge gateway | Window close |
| `ingest_ts` | IoT Core topic rule, or the ingest bridge locally | Arrival in the cloud |
| `detected_ts` | Detection service | Event write |
| `alert_ts` | Alerting service | Notification publish |

That gives three stage latencies and one end to end figure:

```
edge_ts ──────> ingest_ts ──────> detected_ts ──────> alert_ts
        EdgeToIngest     IngestToDetect      DetectToAlert
        └───────────────── EndToEnd ──────────────────┘
```

A stage is only reported when both of its stamps are present. A stage whose interval comes out negative is dropped rather than reported, so a clock that has gone backwards produces a missing sample instead of a negative one that would drag a percentile down.

The stamps are wall clock times from different machines, so the stage figures carry whatever clock skew exists between them. The end to end figure is the one to trust least in absolute terms and most in relative terms: comparing two variants measured the same way is sound, quoting a single number as the true latency is not.

## Metrics emitted

| Metric | Unit | Emitted by |
|---|---|---|
| `EdgeToIngestLatency` | Milliseconds | ingest |
| `IngestToDetectLatency` | Milliseconds | detection |
| `DetectToAlertLatency` | Milliseconds | alerting |
| `EndToEndLatency` | Milliseconds | alerting |
| `MessagesProcessed` | Count | every consumer |
| `MessagesRedelivered` | Count | every consumer |
| `EventsWritten` | Count | detection |
| `ConditionalWriteRejections` | Count | detection, alerting |
| `EpisodesSuppressed` | Count | detection |
| `WindowsStored` | Count | aggregation |
| `DlqArrivals` | Count | every consumer |

`ConditionalWriteRejections` is the duplicate counter. A rejection means a second attempt at work that was already done arrived and was refused, which is the idempotency guarantee working rather than an error.

`MessagesRedelivered` counts messages whose SQS receive count is above one. It is reported separately from the rejection count because they answer different questions. Most windows raise no event at all, so a redelivered window usually produces no rejection, and reading a zero rejection count as proof that nothing was redelivered is wrong.

## Why latency values are batched

A metric target in embedded metric format may be a number or an array of up to 100 numbers.

Latencies are recorded into an array and flushed on an interval rather than written one line per message. At 200 machines the pipeline handles tens of messages a second, and a line per message would be tens of log lines a second per task purely for instrumentation.

CloudWatch treats the array as the full set of observations, so percentiles are computed over every sample rather than over one value per flush. Counters are summed into a single number instead, since the sum is the only thing asked of them.

Recording beyond 100 samples for one metric between flushes drops the excess, because the format will not accept more.
