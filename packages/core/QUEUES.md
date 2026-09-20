# Queues and the bus

Each stage is connected by a queue. Services do not call each other.

## Delivery guarantees

SQS standard queues deliver at least once and do not preserve order. Every consumer handles the same message arriving twice, arriving late, or arriving after a newer one.

A message is deleted only after its handler resolves. If a handler throws, the message stays on the queue, becomes visible again after the visibility timeout, and moves to the dead letter queue once its receive count passes the limit. A task that stops mid-message loses nothing, because it never acknowledged the message.

Messages in a batch are handled in parallel. Windows are independent and every handler is idempotent.

Work that must see the whole batch before any message is handled goes in the `prepare` hook, which runs over the batch first. The detection service uses this to load every window in the batch into its history before evaluating any of them.

A message whose body does not parse is dropped from the batch. It stays unacknowledged and moves to the dead letter queue by receive count. Throwing during receive would fail the whole batch, so one bad message could block the queue.

## Fanout

On AWS, a stage with more than one consumer publishes to an SNS topic. Each consumer has its own queue subscribed to that topic.

There is no SNS locally. `createFanoutPublisher` writes to each subscribing queue directly. Services depend on the `TopicPublisher` interface and do not know which implementation they have.

## Dead letter queues

Every queue has a dead letter queue after 3 receives. The visibility timeout is 60 seconds.

A message on a dead letter queue means a handler failed 3 times. Task restarts do not produce dead letter messages under normal load, because redelivery succeeds well within the receive limit.

## Event identity

An event id is `evt-` plus the first 16 hex characters of the SHA-256 of `machine_id|sensor_type|window_start`. It does not depend on when the event was written or which task wrote it.

The same window judged twice produces the same id. The conditional write that stores it accepts only the first. A redelivery does nothing.

16 hex characters is 64 bits. At 200 machines the pipeline produces about 7 million window ids per day. The chance of a collision at that volume is about 1 in 1,000,000. A shorter id would make collisions likely enough to suppress real events.

A work order id is derived from its event id. The alerting service also consumes from a standard queue.

## Deduplication points

Each service has one point where it decides whether it has already done this work. Each is a single conditional write.

| Service | Deduplication point |
|---|---|
| detection | Alert episode claim, then the conditional event write |
| alerting | Conditional work order write |

A read followed by a write would let two concurrent tasks both conclude they were first.
