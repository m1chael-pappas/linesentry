# Alerting

Consumes events and does three things: notify a technician, drive the machine's actuator, and open a work order.

## Write order

The conditional write on the work order happens first. It is the deduplication point for this service.

`alerting-q` is a standard queue, which delivers at least once, and the service can run more than one task. Without a barrier, a redelivered event would send a second notification and a second command to an actuator. A duplicate row is harmless. A duplicate shutdown command is not.

The work order id is derived from the event id, which is derived from the machine, the sensor and the window start. The same fault produces the same id regardless of which task handles it.

This ordering has a cost. If the process stops between the work order write and the notification, the retry sees the work order already present and skips, so that alert is lost while the work order remains. The alternative ordering loses nothing but can shut a machine down twice. A missed notification with a work order still open for a technician is the better failure.

## Actuator selection

| Event | Actuator |
|---|---|
| `threshold-breach` | `shutdown` |
| Any other `high` severity | `beacon_on` |
| `medium` or `low` | None, work order only |

A threshold breach means a fixed safety limit has been passed. The machine stops without waiting for anyone to look at it.

## Transport

Both destinations are selected from configuration at startup.

| | Local | AWS |
|---|---|---|
| Actuator command | MQTT publish to Mosquitto | IoT Core data plane `Publish` |
| Technician notification | MQTT publish to a topic | SNS publish |

`IOT_DATA_ENDPOINT` selects the IoT Core data plane for actuators. A `NOTIFICATION_TOPIC` that is an SNS ARN selects SNS for notifications. Anything else uses MQTT against `MQTT_URL`.

Locally the service holds an MQTT connection to the broker. On AWS the same publish has to reach a device topic on IoT Core, and IoT Core authenticates MQTT clients with a device certificate. Giving a cloud service a device certificate means provisioning, storing, mounting and rotating it, to authenticate something that already has an IAM role. The data plane API takes the same publish over HTTPS and authorises it with that role.

The device certificate stays on the edge gateway.
