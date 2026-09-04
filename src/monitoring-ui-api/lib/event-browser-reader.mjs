export class EventBrowserReadError extends Error {
  constructor(stage, cause) {
    super(`Kafka Event Browser failed during ${stage}.`, { cause });
    this.name = 'EventBrowserReadError';
    this.stage = stage;
  }
}

export async function readKafkaTopicMessages({
  kafka,
  topic,
  maxMessages,
  readTimeoutMs,
  groupId,
  onStage = () => {},
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay))
}) {
  const admin = kafka.admin();
  const consumer = kafka.consumer({ groupId });
  const partitionTargets = new Map();
  const items = [];
  let done = false;
  let resolveDone = () => {};
  let crashError = null;
  let resolveCrash = () => {};
  const crashPromise = new Promise(resolve => {
    resolveCrash = resolve;
  });

  const recordStage = (stage, labels = {}) => onStage(stage, labels);
  const recordCrash = error => {
    if (crashError) {
      return;
    }

    crashError = error instanceof Error ? error : new Error(String(error ?? 'Kafka consumer crashed.'));
    recordStage('consumer-crash', { error: crashError });
    resolveCrash(crashError);
  };

  const crashEvent = consumer.events?.CRASH;
  if (crashEvent) {
    consumer.on(crashEvent, event => recordCrash(event?.payload?.error ?? event?.error));
  }

  try {
    recordStage('admin-connect');
    await admin.connect();
    recordStage('admin-offsets');
    const offsets = await admin.fetchTopicOffsets(topic.name);
    for (const partitionOffset of offsets) {
      const high = BigInt(partitionOffset.high ?? partitionOffset.offset ?? '0');
      const low = BigInt(partitionOffset.low ?? '0');
      if (high <= low) {
        continue;
      }

      const requestedStart = high - BigInt(maxMessages);
      const start = requestedStart > low ? requestedStart : low;
      partitionTargets.set(Number(partitionOffset.partition), {
        start,
        high,
        done: false
      });
    }
  } catch (error) {
    throw new EventBrowserReadError('admin-offsets', error);
  } finally {
    await disconnectKafka(admin);
  }

  if (partitionTargets.size === 0) {
    return [];
  }

  const donePromise = new Promise(resolve => {
    resolveDone = resolve;
  });

  try {
    recordStage('consumer-connect');
    await consumer.connect();
    recordStage('consumer-subscribe');
    await consumer.subscribe({ topic: topic.name, fromBeginning: true });
    recordStage('consumer-run');
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ partition, message }) => {
        const target = partitionTargets.get(Number(partition));
        if (!target) {
          return;
        }

        const offset = BigInt(message.offset);
        if (offset < target.start || offset >= target.high) {
          return;
        }

        items.push({
          topic: topic.name,
          service: topic.service,
          direction: topic.direction,
          partition,
          offset: message.offset,
          timestamp: message.timestamp ? new Date(Number(message.timestamp)).toISOString() : '',
          key: message.key?.toString('utf8') ?? '',
          value: message.value?.toString('utf8') ?? '',
          headers: headersToObject(message.headers)
        });

        if (offset >= target.high - 1n) {
          target.done = true;
        }

        if (items.length >= maxMessages || [...partitionTargets.values()].every(item => item.done)) {
          done = true;
          resolveDone();
        }
      }
    });

    if (crashError) {
      throw new EventBrowserReadError('consumer-crash', crashError);
    }

    for (const [partition, target] of partitionTargets) {
      if (crashError) {
        throw new EventBrowserReadError('consumer-crash', crashError);
      }

      recordStage('consumer-seek', { partition });
      consumer.seek({
        topic: topic.name,
        partition,
        offset: target.start.toString()
      });
    }

    const result = await Promise.race([
      donePromise.then(() => ({ kind: 'done' })),
      sleep(readTimeoutMs).then(() => ({ kind: 'timeout' })),
      crashPromise.then(error => ({ kind: 'crash', error }))
    ]);
    if (result.kind === 'crash') {
      throw new EventBrowserReadError('consumer-crash', result.error);
    }
    if (result.kind === 'timeout') {
      recordStage('read-timeout');
    }
  } catch (error) {
    if (error instanceof EventBrowserReadError) {
      throw error;
    }
    throw new EventBrowserReadError(crashError ? 'consumer-crash' : 'consumer-read', crashError ?? error);
  } finally {
    if (!done) {
      resolveDone();
    }
    await disconnectKafka(consumer);
  }

  return items
    .sort((left, right) => {
      if (left.topic !== right.topic) {
        return left.topic.localeCompare(right.topic);
      }
      if (left.partition !== right.partition) {
        return left.partition - right.partition;
      }
      return Number(BigInt(left.offset) - BigInt(right.offset));
    })
    .slice(-maxMessages);
}

async function disconnectKafka(client) {
  try {
    await client.disconnect();
  } catch {
    // A cleanup failure must not hide the Kafka operation failure.
  }
}

function headersToObject(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    Array.isArray(value)
      ? value.map(item => item?.toString('utf8') ?? '')
      : value?.toString('utf8') ?? ''
  ]));
}
