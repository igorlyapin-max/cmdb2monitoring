import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSerialExecutor,
  readActiveRulesDocument,
  rulesRevision,
  writeRulesAtomically
} from '../lib/active-rules-publication.mjs';

test('active rules revision follows exact persisted content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monitoring-ui-rules-'));
  const path = join(directory, 'rules.json');
  const initialContent = '{"rulesVersion":"one"}\n';
  await writeFile(path, initialContent, 'utf8');

  const initial = await readActiveRulesDocument(path);
  assert.equal(initial.revision, rulesRevision(initialContent));

  const written = await writeRulesAtomically(path, { rulesVersion: 'two' });
  assert.equal(written.revision, rulesRevision(written.content));
  assert.equal(await readFile(path, 'utf8'), written.content);
  assert.deepEqual(await readdir(directory), ['rules.json']);
});

test('serial executor prevents interleaving publication operations', async () => {
  const runExclusive = createSerialExecutor();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });

  const first = runExclusive(async () => {
    events.push('first-start');
    await firstGate;
    events.push('first-end');
  });
  const second = runExclusive(async () => {
    events.push('second');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});
