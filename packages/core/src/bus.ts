import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { optionalEnv } from './runtime.js';

/** A message taken off a queue, with the handle needed to delete it. */
export interface QueueMessage<T> {
  body: T;
  receiptHandle: string;
  receiveCount: number;
}

/** Pulls messages off one queue and deletes them once they are handled. */
export interface QueueConsumer<T> {
  receive(): Promise<QueueMessage<T>[]>;
  acknowledge(message: QueueMessage<T>): Promise<void>;
}

/** Delivers one message to every subscriber of a logical topic. */
export interface TopicPublisher<T> {
  publish(message: T): Promise<void>;
}

/** Returns an SQS client, overriding the endpoint when `SQS_ENDPOINT` is set. */
export function createSqsClient(): SQSClient {
  const endpoint = optionalEnv('SQS_ENDPOINT', '');
  return new SQSClient(endpoint ? { endpoint } : {});
}

/** How long a receive call waits for messages, and how many it takes at once. */
export interface ConsumerOptions {
  waitTimeSeconds?: number;
  batchSize?: number;
}

/**
 * Returns a consumer over one SQS queue.
 *
 * Long polls for `waitTimeSeconds`, default 10, and takes at most `batchSize`
 * messages, default 10. Bodies are parsed as JSON; a message whose body does
 * not parse is logged and omitted from the batch, leaving it unacknowledged.
 * See ../QUEUES.md.
 */
export function createQueueConsumer<T>(
  client: SQSClient,
  queueUrl: string,
  options: ConsumerOptions = {},
): QueueConsumer<T> {
  const waitTimeSeconds = options.waitTimeSeconds ?? 10;
  const batchSize = options.batchSize ?? 10;

  return {
    async receive() {
      const result = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: batchSize,
          WaitTimeSeconds: waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );

      return (result.Messages ?? []).flatMap((message) => {
        if (!message.Body || !message.ReceiptHandle) return [];

        let body: T;
        try {
          body = JSON.parse(message.Body) as T;
        } catch {
          console.error(`dropping unparsable message ${message.MessageId ?? 'unknown'}`);
          return [];
        }

        return [
          {
            body,
            receiptHandle: message.ReceiptHandle,
            receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
          },
        ];
      });
    },

    async acknowledge(message) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.receiptHandle }),
      );
    },
  };
}

/**
 * Returns a `TopicPublisher` that sends each message to every queue in
 * `queueUrls`, concurrently.
 *
 * Throws at construction when `queueUrls` is empty. `publish` rejects when any
 * send rejects, with no rollback of the sends that succeeded.
 */
export function createFanoutPublisher<T>(
  client: SQSClient,
  queueUrls: readonly string[],
): TopicPublisher<T> {
  if (queueUrls.length === 0) {
    throw new Error('fanout publisher needs at least one queue url');
  }

  return {
    async publish(message) {
      const body = JSON.stringify(message);
      await Promise.all(
        queueUrls.map((queueUrl) =>
          client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body })),
        ),
      );
    },
  };
}

/** Splits on commas, trims each entry and drops empty ones. */
export function parseQueueUrls(value: string): string[] {
  return value
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/** A running consumer loop that can be asked to finish what it holds and stop. */
export interface ConsumerLoop {
  stop(): Promise<void>;
}

/**
 * Polls `consumer` until stopped, running `prepare` over each batch and then
 * `handle` on every message in it concurrently.
 *
 * A message is acknowledged only after its handler resolves. A handler that
 * rejects is logged and the message is left unacknowledged. A failing receive
 * is logged and retried after one second.
 *
 * `stop` clears the running flag, awaits the batch in flight and resolves once
 * the loop has exited. See ../QUEUES.md.
 */
export function runConsumerLoop<T>(
  consumer: QueueConsumer<T>,
  handle: (message: QueueMessage<T>) => Promise<void>,
  prepare?: (batch: readonly QueueMessage<T>[]) => void,
): ConsumerLoop {
  let running = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  const pump = async (): Promise<void> => {
    while (running) {
      let batch: QueueMessage<T>[];
      try {
        batch = await consumer.receive();
      } catch (error) {
        console.error('receive failed', error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (batch.length === 0) continue;

      prepare?.(batch);

      inFlight = Promise.all(
        batch.map(async (message) => {
          try {
            await handle(message);
            await consumer.acknowledge(message);
          } catch (error) {
            console.error(`handler failed on receive ${message.receiveCount}`, error);
          }
        }),
      );
      await inFlight;
    }
  };

  const finished = pump();

  return {
    async stop() {
      running = false;
      await inFlight;
      await finished;
    },
  };
}
