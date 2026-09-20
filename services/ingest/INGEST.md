# Ingest bridge

This service exists only in the local stack.

On AWS the edge gateway publishes to IoT Core, a topic rule matches `linesentry/edge/#`, the rule's SQL adds `ingest_ts`, and the rule action sends the window to the `linesentry-windows` SNS topic, which fans out to `aggregation-q` and `detection-q`.

There is no IoT Core locally, so this bridge does the same three things: subscribe to the edge topic on Mosquitto, stamp `ingest_ts`, and write to each queue that SNS would have delivered to.

It is in the compose file and not in the Terraform, and no service downstream can tell which of the two put the message on its queue.

Keeping the local fanout in a service rather than pointing the gateway straight at the queues matters for one reason: the second stamp in the latency chain has to be applied at the same point in both environments, or the per-stage latency numbers from a local run and an AWS run are not measuring the same interval.
