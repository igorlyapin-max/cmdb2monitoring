import assert from 'node:assert/strict';
import test from 'node:test';

import { EventBrowserReadError, readKafkaTopicMessages } from '../lib/event-browser-reader.mjs';

const topic = { name: 'customer.pipeline', service: 'converter', direction: 'output' };

test('reads the selected tail window and closes Kafka clients', async () => {
  const fixture = createKafkaFixture({ messages: ['3', '4'] });
  const items = await readKafkaTopicMessages({
    kafka: fixture.kafka,
    topic,
    maxMessages: 2,
    readTimeoutMs: 10,
    groupId: 'test-events-success',
    sleep: async () => {}
  });

  assert.deepEqual(items.map(item => item.offset), ['3', '4']);
  assert.equal(fixture.calls.adminDisconnect, 1);
  assert.equal(fixture.calls.consumerDisconnect, 1);
  assert.deepEqual(fixture.calls.seekOffsets, ['0:3']);
});

test('selects the latest messages across all topic partitions', async () => {
  const fixture = createKafkaFixture({
    partitionOffsets: [
      { partition: 0, low: '0', high: '5' },
      { partition: 1, low: '0', high: '5' }
    ],
    messages: [
      { partition: 0, offset: '3', timestamp: '100' },
      { partition: 0, offset: '4', timestamp: '200' },
      { partition: 1, offset: '3', timestamp: '300' },
      { partition: 1, offset: '4', timestamp: '400' }
    ]
  });

  const items = await readKafkaTopicMessages({
    kafka: fixture.kafka,
    topic,
    maxMessages: 2,
    readTimeoutMs: 10,
    groupId: 'test-events-multipartition',
    sleep: async () => {}
  });

  assert.deepEqual(items.map(item => `${item.partition}:${item.offset}`), ['1:3', '1:4']);
  assert.deepEqual(fixture.calls.seekOffsets, ['0:3', '1:3']);
});

test('keeps the primary consumer crash and skips seek', async () => {
  const primaryError = new Error('Topic authorization failed');
  const fixture = createKafkaFixture({ crashOnRun: primaryError });
  const stages = [];

  await assert.rejects(
    () => readKafkaTopicMessages({
      kafka: fixture.kafka,
      topic,
      maxMessages: 2,
      readTimeoutMs: 10,
      groupId: 'test-events-crash',
      onStage: (stage, labels) => stages.push({ stage, labels }),
      sleep: async () => {}
    }),
    error => error instanceof EventBrowserReadError
      && error.stage === 'consumer-crash'
      && error.cause === primaryError
  );

  assert.deepEqual(fixture.calls.seekOffsets, []);
  assert.equal(fixture.calls.consumerDisconnect, 1);
  assert.equal(stages.at(-1).stage, 'consumer-crash');
});

test('labels an explicit seek failure and closes the consumer', async () => {
  const fixture = createKafkaFixture({ seekError: new Error('seek rejected') });

  await assert.rejects(
    () => readKafkaTopicMessages({
      kafka: fixture.kafka,
      topic,
      maxMessages: 2,
      readTimeoutMs: 10,
      groupId: 'test-events-seek',
      sleep: async () => {}
    }),
    error => error instanceof EventBrowserReadError
      && error.stage === 'consumer-read'
      && error.cause.message === 'seek rejected'
  );

  assert.equal(fixture.calls.consumerDisconnect, 1);
});

test('closes the consumer when the read window times out', async () => {
  const fixture = createKafkaFixture();
  const stages = [];
  await readKafkaTopicMessages({
    kafka: fixture.kafka,
    topic,
    maxMessages: 2,
    readTimeoutMs: 10,
    groupId: 'test-events-timeout',
    onStage: stage => stages.push(stage),
    sleep: async () => {}
  });

  assert.equal(fixture.calls.consumerDisconnect, 1);
  assert.ok(stages.includes('read-timeout'));
});

function createKafkaFixture({
  messages = [],
  partitionOffsets = [{ partition: 0, low: '0', high: '5' }],
  crashOnRun = null,
  seekError = null
} = {}) {
  const calls = { adminDisconnect: 0, consumerDisconnect: 0, seekOffsets: [] };
  let crashListener = null;
  let eachMessage = null;
  const consumer = {
    events: { CRASH: 'crash' },
    on(event, listener) {
      if (event === 'crash') {
        crashListener = listener;
      }
    },
    async connect() {},
    async subscribe() {},
    async run(options) {
      eachMessage = options.eachMessage;
      if (crashOnRun) {
        crashListener({ payload: { error: crashOnRun } });
      }
    },
    seek({ partition, offset }) {
      if (seekError) {
        throw seekError;
      }
      calls.seekOffsets.push(`${partition}:${offset}`);
      for (const rawMessage of messages) {
        const message = typeof rawMessage === 'string'
          ? { partition: 0, offset: rawMessage, timestamp: '0' }
          : rawMessage;
        if (message.partition !== partition) {
          continue;
        }
        void eachMessage({
          partition: message.partition,
          message: {
            offset: message.offset,
            timestamp: message.timestamp ?? '0',
            key: Buffer.from('key'),
            value: Buffer.from(`value-${message.offset}`),
            headers: {}
          }
        });
      }
    },
    async disconnect() {
      calls.consumerDisconnect += 1;
    }
  };

  return {
    calls,
    kafka: {
      admin() {
        return {
          async connect() {},
          async fetchTopicOffsets() {
            return partitionOffsets;
          },
          async disconnect() {
            calls.adminDisconnect += 1;
          }
        };
      },
      consumer() {
        return consumer;
      }
    }
  };
}
