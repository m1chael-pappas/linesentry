import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { PublishCommand as SnsPublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { MqttClient } from 'mqtt';
import type { ActuatorCommand, DetectionEvent } from '@linesentry/core';

/** Sends a command to one machine's actuator topic. */
export interface ActuatorPublisher {
  publish(topic: string, command: ActuatorCommand): Promise<void>;
}

/** Sends a technician notification. */
export interface NotificationPublisher {
  publish(event: DetectionEvent & { alert_ts: number }): Promise<void>;
}

/**
 * Publishes actuator commands over an MQTT connection.
 *
 * Rejects when the broker reports a publish error.
 */
export function createMqttActuatorPublisher(client: MqttClient): ActuatorPublisher {
  return {
    publish(topic, command) {
      return new Promise((resolve, reject) => {
        client.publish(topic, JSON.stringify(command), (error) =>
          error ? reject(error) : resolve(),
        );
      });
    },
  };
}

/**
 * Publishes actuator commands through the IoT Core data plane.
 *
 * Authorises with the task's IAM credentials rather than a device
 * certificate. See ../ALERTING.md.
 */
export function createIotActuatorPublisher(endpoint: string): ActuatorPublisher {
  const client = new IoTDataPlaneClient({ endpoint: `https://${endpoint}` });

  return {
    async publish(topic, command) {
      await client.send(
        new PublishCommand({
          topic,
          qos: 1,
          payload: Buffer.from(JSON.stringify(command)),
        }),
      );
    },
  };
}

/** Publishes notifications to an MQTT topic. */
export function createMqttNotificationPublisher(
  client: MqttClient,
  topic: string,
): NotificationPublisher {
  return {
    publish(event) {
      return new Promise((resolve, reject) => {
        client.publish(topic, JSON.stringify(event), (error) =>
          error ? reject(error) : resolve(),
        );
      });
    },
  };
}

/** Publishes notifications to an SNS topic, subject lined with the machine and severity. */
export function createSnsNotificationPublisher(topicArn: string): NotificationPublisher {
  const client = new SNSClient({});

  return {
    async publish(event) {
      await client.send(
        new SnsPublishCommand({
          TopicArn: topicArn,
          Subject: `${event.severity} on ${event.machine_id}`,
          Message: JSON.stringify(event, null, 2),
        }),
      );
    },
  };
}

/** True when the value is an SNS topic ARN rather than an MQTT topic name. */
export function isSnsTopic(value: string): boolean {
  return value.startsWith('arn:aws:sns:');
}
