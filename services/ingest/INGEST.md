# Ingest bridge

This service runs only in the local stack.

On AWS the edge gateway publishes to IoT Core. A topic rule matches `linesentry/edge/#`, its SQL adds `ingest_ts`, and the rule action sends the window to the `linesentry-windows` SNS topic, which fans out to `aggregation-q` and `detection-q`.

There is no IoT Core locally, so this bridge does the same three things: subscribe to the edge topic on Mosquitto, stamp `ingest_ts`, and write to each queue that SNS would have delivered to.

It is in the compose file and not in the Terraform. No downstream service can tell which of the two put the message on its queue.

The local fanout is a service rather than the gateway writing straight to the queues, because `ingest_ts` has to be applied at the same point in the chain in both environments. Otherwise per-stage latency from a local run and an AWS run measure different intervals.
