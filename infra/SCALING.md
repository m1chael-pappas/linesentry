# Detection autoscaling

Only the detection service scales. Aggregation, alerting and the api run a single task each.

That is deliberate rather than an omission. Aggregation does one write per window, so its work grows with machine count and is trivially parallel but never backs up. Alerting only sees events, which are rare compared to windows. Detection is the stage whose cost rises with both machine count and fault load, and it is the one holding a queue that visibly grows, so it is the only place where scaling can be demonstrated rather than asserted.

## The metric

Target tracking on backlog per task, held at 50.

Backlog per task is not a metric AWS publishes, so the policy computes it with metric math:

```
m1  AWS/SQS ApproximateNumberOfMessagesVisible   QueueName=linesentry-detection-q   Sum
m2  ECS/ContainerInsights RunningTaskCount       ClusterName, ServiceName           Average
e1  m1 / m2                                                                         returned
```

`RunningTaskCount` only exists when Container Insights is enabled on the cluster, which is why `aws_ecs_cluster.main` sets it. Without it the expression returns no data and the policy never fires.

Scaling on the raw queue depth instead would be wrong: a depth of 500 means something entirely different with one task than with six, so the policy would keep adding tasks to a queue that was already draining.

## Chosen values

| Setting | Value | Reason |
|---|---|---|
| Target backlog per task | 50 | At roughly 20 windows a second and a handler taking a few milliseconds, one task clears 50 messages in well under a second. A target this low makes the service scale while the queue is still shallow, which is what keeps end to end latency inside the 5 second budget during a burst. |
| Minimum tasks | 1 | The pipeline must keep working with no load. |
| Maximum tasks | 6 | The burst run drives 200 machines, which is about 80 windows a second. Six tasks is several times the throughput that needs, so the ceiling is high enough not to be the limit being measured. |
| Scale out cooldown | 60s | Long enough that a scale-out is running before the next is considered, short enough to add tasks during a burst rather than after it. |
| Scale in cooldown | 60s | The minimum useful value. See below for why it is not what governs scale-in speed. |

## Scale-in takes about fifteen minutes, and that is not tunable

Target tracking creates its own CloudWatch alarms. The ones it created here are:

| Alarm | Condition | Evaluation periods |
|---|---|---|
| AlarmHigh | backlog per task > 50 | 3 |
| AlarmLow | backlog per task < 45 | 15 |

Scale-out therefore needs three one-minute datapoints above target, so it begins after roughly three minutes of sustained backlog. Scale-in needs fifteen, so it begins after roughly fifteen minutes below target.

`scale_in_cooldown` does not change this. It governs how long Application Auto Scaling waits between consecutive scale-in actions once the alarm has already fired, not how long the alarm takes to fire. There is no setting on a target tracking policy that shortens the fifteen datapoint requirement, because Application Auto Scaling owns those alarms.

The consequence for the experiments is that the scale-in run has to be at least fifteen minutes, closer to twenty to see the task count settle back at one. A ten minute run would report that scale-in did not happen, and the reason would be the measurement window rather than the system.

The alternative would be a separate step scaling policy for scale-in with a shorter alarm. That is not used here because two policies acting on the same dimension can disagree, and the flapping that produces would be a worse artefact in the results than a slow scale-in that is understood and stated.

Asymmetry between scale-out and scale-in is also the correct default for this workload. Adding a task during a burst costs a few cents and protects latency. Removing one too eagerly risks doing it just before the next burst, and the cost of being slow to remove a task is far lower than the cost of being slow to add one.
