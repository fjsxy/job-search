import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSubscriptionClient } from '../src/subscription.mjs';

test('订阅进程使用专用运行目录，发现附加指令时拒绝发送任务', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-search-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, 'codex-home');
  const captured = join(directory, 'captured');
  const executable = join(directory, 'codex-fixture');
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify(process.env.CODEX_HOME) + '\\n');
if (process.argv.includes('login')) {
  console.log('Logged in using ChatGPT');
} else {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
`, { mode: 0o700 });
  const subscription = createSubscriptionClient({ executable, codexHome });
  const task = { prompt: '合成订阅任务', schema: { type: 'object' } };
  const result = await subscription.run(task);
  assert.deepEqual(result.value, { ok: true });
  const calls = await readFile(captured, 'utf8');
  assert.deepEqual(calls.trim().split('\n').map(JSON.parse), [codexHome, codexHome]);

  await writeFile(join(codexHome, 'AGENTS.override.md'), '不可发送的合成上下文');
  await assert.rejects(() => subscription.run(task), /专用登录目录.*AGENTS/);
  assert.equal(await readFile(captured, 'utf8'), calls);
});
