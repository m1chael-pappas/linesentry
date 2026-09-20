# Autoscaling

The detection and aggregation services scale. Alerting and the api run a single task each.

The first version scaled only detection, on the assumption that it was the stage whose cost rises with machine count and fault load. The first burst run showed otherwise. The aggregation queue peaked at 260 messages while the detection queue stayed at 0, and Application Auto Scaling recorded no scaling activity for detection.

Aggregation writes to DynamoDB for every window. Detection reads cached metadata and, for most windows, returns without writing anything. At 200 machines with 10 second windows, aggregation is the stage that queues.

Both services now use the same policy. Alerting only sees events, which are rare compared to windows, and the api serves occasional reads.

## Metric

Target tracking on backlog per task, held at 50, for each scaled service.

Backlog per task is not a metric AWS publishes, so the policy computes it with metric math. For detection:

```
m1  AWS/SQS ApproximateNumberOfMessagesVisible   QueueName=linesentry-detection-q   Sum
m2  ECS/ContainerInsights RunningTaskCount       ClusterName, ServiceName           Average
e1  m1 / m2                                                                         returned
```

`RunningTaskCount` exists only when Container Insights is enabled on the cluster, which is why `aws_ecs_cluster.main` sets it. Without it the expression returns no data and the policy never fires.

Scaling on raw queue depth would be wrong. A depth of 500 means something different with one task than with six, so the policy would keep adding tasks to a queue that was already draining.

## Values

| Setting | Value | Reason |
|---|---|---|
| Target backlog per task | 50 | At about 20 windows per second and a handler taking a few milliseconds, one task clears 50 messages in under a second. A low target scales the service while the queue is still shallow, which keeps end to end latency inside the 5 second budget during a burst. |
| Minimum tasks | 1 | The pipeline must keep working with no load. |
| Maximum tasks | 6 | The burst run drives 200 machines, about 80 windows per second. Six tasks is several times that throughput, so the ceiling is not the limit being measured. |

The same values apply to aggregation, set by `aggregation_backlog_target` and `aggregation_max_tasks`.
| Scale out cooldown | 60s | Long enough for a scale-out to take effect before the next is considered, short enough to add tasks during a burst. |
| Scale in cooldown | 60s | The minimum useful value. See below. |

## Scale-in timing

Target tracking creates its own CloudWatch alarms. The alarms it created here are:

| Alarm | Condition | Evaluation periods |
|---|---|---|
| AlarmHigh | backlog per task > 50 | 3 |
| AlarmLow | backlog per task < 45 | 15 |

Scale-out needs 3 one-minute datapoints above target, so it begins after about 3 minutes of sustained backlog. Scale-in needs 15, so it begins after about 15 minutes below target.

`scale_in_cooldown` does not change this. It sets how long Application Auto Scaling waits between consecutive scale-in actions once the alarm has fired, not how long the alarm takes to fire. A target tracking policy has no setting that shortens the 15 datapoint requirement, because Application Auto Scaling owns those alarms.

The scale-in run therefore needs at least 15 minutes, and closer to 20 to see the task count settle at 1. A 10 minute run would report that scale-in did not happen, and the cause would be the measurement window.

A separate step scaling policy for scale-in with a shorter alarm would be faster. I did not use one, because two policies acting on the same dimension can disagree, and the resulting flapping would be a worse artefact in the results than a slow scale-in that is stated.

Asymmetry between scale-out and scale-in also suits this workload. Adding a task during a burst costs a few cents and protects latency. Removing one too early risks doing it just before the next burst.
