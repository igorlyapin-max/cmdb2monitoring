import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function readActiveRulesDocument(path) {
  const content = await readFile(path, 'utf8');
  return {
    content,
    rules: JSON.parse(content),
    revision: rulesRevision(content)
  };
}

export function rulesRevision(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function writeRulesAtomically(path, rules) {
  const content = JSON.stringify(rules, null, 2) + '\n';
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), '.' + basename(path) + '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx'
    });
    await rename(temporaryPath, path);
    return {
      content,
      revision: rulesRevision(content)
    };
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export function createSerialExecutor() {
  let tail = Promise.resolve();
  return async operation => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}
