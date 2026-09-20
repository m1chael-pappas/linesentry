# Queues and the bus

Every stage is decoupled through a queue. Services never call each other.

## Delivery guarantees

SQS standard queues deliver at least once and do not order messages. Every consumer here is therefore written to tolerate the same message arriving twice, arriving late, or arriving after a newer one.

A message is deleted only after its handler resolves. A handler that throws leaves the message on the queue, so it becomes visible again after the visibility timeout and reaches the dead letter queue once its receive count passes the queue's limit. A task that dies mid-message loses nothing for the same reason: it never acknowledged, so the message comes back.

Messages within a batch are handled in parallel, because windows are independent of one another and every handler is idempotent. Work that must see the whole batch before any of it is judged goes in the `prepare` hook instead, which runs over the batch first. The detection service uses that to load every window in the batch into its history before evaluating any of them, so the outcome does not depend on which handler the scheduler happens to run first.

A message whose body will not parse is dropped from the batch rather than throwing. Throwing during receive would fail the whole batch before any message in it was handled, so one malformed message would stall the queue permanently. Dropping it leaves it unacknowledged, so it rides its receive count to the dead letter queue like any other failure.

## Fanout

On AWS a stage that has more than one consumer publishes to an SNS topic, and each consumer has its own queue subscribed to it.

There is no SNS locally, so `createFanoutPublisher` writes to each subscribing queue directly. Services depend on the `TopicPublisher` interface and cannot tell which one they were given.

## Dead letter queues

Every queue has one, after three receives. The visibility timeout is 60 seconds, which is well above the worst case handler time.

A message on a dead letter queue means a handler failed three times. It does not mean a task died, since that case is recovered by redelivery without the receive count running out under normal load.

## Event identity

An event id is `evt-` followed by sixteen hex characters of a SHA-256 hash of the machine id, the sensor type and the window start. It depends on what the event is about and never on when it was written or which task wrote it.

Two consequences follow.

The same window judged twice, by a redelivery or by two tasks at once, produces the same id both times, and the conditional write that stores it accepts only the first. A redelivery does nothing rather than raising a second alert.

Sixteen hex characters is 64 bits. At 200 machines the pipeline produces roughly 7 million window ids a day, where the chance of a collision is about one in a million. A shorter id would make a collision likely enough to suppress a real event, which is why the id is not as short as the example in the brief.

A work order id is derived from its event id for the same reason, since the alerting service also consumes from a standard queue.

## Where deduplication happens

Each service has exactly one point where it decides whether it has seen this work before, and that point is always a single conditional write rather than a read followed by a write.

| Service | Barrier |
|---|---|
| detection | Alert episode claim, then the conditional event write |
| alerting | Conditional work order write |

Reading first and writing second would let two tasks both conclude they were first.
