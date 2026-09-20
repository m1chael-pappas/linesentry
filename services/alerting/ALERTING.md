# Alerting

Consumes events and does three things: notify a technician, drive the machine's actuator, and open a work order.

## Why the work order is written first

The conditional write on the work order is the deduplication point for this service, so it happens before anything else.

`alerting-q` is a standard queue, which delivers at least once, and the service can run as more than one task. Without a barrier, a redelivered event would send a second notification to a technician and a second command to a physical actuator. A duplicate row is harmless; a duplicate shutdown command is not.

Putting the conditional write first means the second delivery stops at that check and does nothing. The work order id is derived from the event id, which is itself derived from the machine, the sensor and the window start, so the same fault always produces the same id no matter which task handles it or how many times.

The ordering does have a cost. If the process dies between the work order write and the notification, the retry sees the work order already present and skips, so that one alert is lost while the work order remains. The alternative ordering loses nothing but can shut a machine down twice. Between a missed notification with a work order still sitting open for a technician, and a repeated actuation on plant equipment, the missed notification is the better failure.

## What drives which actuator

| Event | Actuator |
|---|---|
| `threshold-breach` | `shutdown` |
| Any other `high` severity | `beacon_on` |
| `medium` or `low` | Nothing, work order only |

A threshold breach means a fixed safety limit has been passed, which is the case where the machine should stop without waiting for anyone to look at it.

## How it reaches the machine and the technician

Both destinations are chosen from configuration at startup, because the right mechanism differs between environments and neither service code nor the message contract should know which one it got.

| | Local | AWS |
|---|---|---|
| Actuator command | MQTT publish to Mosquitto | IoT Core data plane `Publish` |
| Technician notification | MQTT publish to a topic | SNS publish |

Setting `IOT_DATA_ENDPOINT` selects the IoT Core data plane for actuators, and a `NOTIFICATION_TOPIC` that is an SNS ARN selects SNS for notifications. Anything else falls back to MQTT against `MQTT_URL`.

The actuator path deserves the explanation. Locally the service holds an ordinary MQTT connection to the broker. On AWS the same publish has to reach a device topic on IoT Core, and IoT Core authenticates MQTT clients with a device certificate. Giving a cloud service a device certificate would mean provisioning one, storing it, mounting it into the task and rotating it, all to authenticate something that already has an IAM role. The data plane API takes the same publish over HTTPS and authorises it with that role instead, so there is no certificate to manage and no second identity for the service.

The device certificate stays where it belongs, on the edge gateway, which is the only thing in the system that actually is a device.
