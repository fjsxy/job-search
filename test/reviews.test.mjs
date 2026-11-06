import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { startApp } from '../src/app.mjs';

const FULL_TRANSCRIPT = '面试官：如何诊断滚动更新变慢？\n候选人：我先查 Pod Events 和 readiness probe。';
const COMPLETED_REVIEW = {
  status: 'completed', missingContext: [], questions: [{
    summary: '滚动更新变慢时如何定位问题',
    evaluation: '从 Events 和 readiness probe 入手合理',
    improvements: ['检查 Deployment rollout status'],
  }],
};

// 通过本机页面登记职位与轮次，只替换外部订阅边界。
async function openRounds(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'job-search-review-test-'));
  const app = await startApp({ port: 0, dataDir: join(root, 'data'), subscription: { run } });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const post = (path, fields) => fetch(new URL(path, app.origin), {
    method: 'POST', headers: { Origin: app.origin }, redirect: 'manual',
    body: fields instanceof FormData ? fields : new URLSearchParams(fields),
  });
  const page = async (path) => {
    const response = await fetch(new URL(path, app.origin));
    assert.equal(response.status, 200);
    return response.text();
  };
  const job = await post('/jobs', { jd: '不应发送的私有 JD' });
  assert.equal(job.status, 303);
  const jobPath = job.headers.get('location');
  assert.equal((await post(`${jobPath}/application`, {})).status, 303);
  const roundsPath = `${jobPath}/application/interviews`;
  assert.equal((await post(roundsPath, { result: 'passed' })).status, 303);
  assert.equal((await post(roundsPath, { result: 'passed' })).status, 303);
  const detail = await page(jobPath);
  const first = detail.match(/href="([^"]+)">一面<\/a>/)[1];
  const second = detail.match(/href="([^"]+)">二面<\/a>/)[1];
  return { root, post, page, first, second };
}

function transcriptFile(filename, transcript) {
  const data = new FormData();
  data.set('transcript', new Blob([transcript], { type: 'text/plain' }), filename);
  return data;
}

function confirmedVersion(page) {
  const version = page.match(/name="version" value="([^"]+)"/)?.[1];
  assert.ok(version, '预览页面应允许确认当前版本');
  return version;
}

async function waitFor(page, path, text) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const body = await page(path);
    if (body.includes(text)) return body;
    await setTimeout(20);
  }
  assert.fail(`轮次页面未出现「${text}」`);
}

test('JS-06-01 仅将当前轮次明确确认的版本提交给禁用公开搜索的订阅调用', async (t) => {
  const requests = [];
  const { root, post, page, first, second } = await openRounds(t, async request => {
    requests.push(request);
    return { value: COMPLETED_REVIEW };
  });
  assert.match(await page(second), /上传转写稿/);
  assert.equal((await post(`${second}/review-directory`, { directory: root })).status, 303);
  assert.equal((await post('/settings/agent-speed', { speed: 'standard' })).status, 303);
  assert.equal((await post(`${first}/transcript`, transcriptFile('一面.txt', '不得发送的一面内容'))).status, 303);
  assert.equal((await post(`${second}/transcript`, transcriptFile('初稿.txt', '不得发送的旧版本'))).status, 303);
  const previousVersion = confirmedVersion(await page(second));
  assert.equal((await post(`${second}/transcript`, transcriptFile('补全.md', FULL_TRANSCRIPT))).status, 303);
  const preview = await page(second);
  assert.match(preview, /补全\.md/);
  assert.ok(preview.includes(FULL_TRANSCRIPT));
  const version = confirmedVersion(preview);
  assert.equal((await post(`${second}/review`, { version: previousVersion })).status, 409);
  assert.equal((await post(`${first}/review`, { version })).status, 409);
  assert.equal(requests.length, 0);

  const confirmations = await Promise.all([
    post(`${second}/review`, { version }),
    post(`${second}/review`, { version }),
  ]);
  assert.deepEqual(confirmations.map(response => response.status), [303, 303]);
  await waitFor(page, second, '复盘文件已保存');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].fastMode, false);
  assert.equal(requests[0].webSearch, false);
  assert.ok(requests[0].prompt.includes(JSON.stringify(FULL_TRANSCRIPT)));
  assert.doesNotMatch(requests[0].prompt, /不应发送的私有 JD|不得发送|补全\.md|job-search-review-test-/);
  assert.match(await page(first), /不得发送的一面内容/);
});

test('JS-06-02 缺失片段中止整轮，不写部分复盘，补齐后可保存完整报告', async (t) => {
  const missingTranscript = '面试官：如何诊断滚动更新变慢？\n候选人：[录音中断]';
  const missingContext = ['请补充滚动更新变慢的完整回答'];
  const { root, post, page, second } = await openRounds(t, async ({ prompt }) => ({
    // 即使订阅返回相互矛盾的标志，只要指出关键缺失，就不能落盘部分复盘。
    value: prompt.includes(JSON.stringify(missingTranscript))
      ? { ...COMPLETED_REVIEW, missingContext }
      : COMPLETED_REVIEW,
  }));
  assert.equal((await post(`${second}/review-directory`, { directory: root })).status, 303);
  assert.equal((await post(`${second}/transcript`, transcriptFile('二面.txt', missingTranscript))).status, 303);
  const incomplete = confirmedVersion(await page(second));
  assert.equal((await post(`${second}/review`, { version: incomplete })).status, 303);
  const stopped = await waitFor(page, second, '上下文不足，已停止整轮复盘');
  assert.match(stopped, /请补充滚动更新变慢的完整回答/);
  assert.doesNotMatch(stopped, /复盘文件已保存|确认提交本稿/);
  assert.deepEqual(await readdir(root), ['data']);

  assert.equal((await post(`${second}/transcript`, transcriptFile('二面.md', FULL_TRANSCRIPT))).status, 303);
  const completed = confirmedVersion(await page(second));
  assert.equal((await post(`${second}/review`, { version: completed })).status, 303);
  const saved = await waitFor(page, second, '复盘文件已保存');
  const files = (await readdir(root)).filter(name => name.endsWith('.md'));
  assert.equal(files.length, 1);
  const report = join(root, files[0]);
  assert.ok(saved.includes(report));
  const content = await readFile(report, 'utf8');
  assert.match(content, /### 问题概括\n\n滚动更新变慢时如何定位问题/);
  assert.match(content, /### 回答评价\n\n从 Events 和 readiness probe 入手合理/);
  assert.match(content, /### 优化点\n\n- 检查 Deployment rollout status/);
});

test('JS-06-03 写入失败时保留确认稿，修正目录后可重试且保留已有文件', async (t) => {
  const { root, post, page, second } = await openRounds(t, async () => ({ value: COMPLETED_REVIEW }));
  const existing = join(root, '已有文件.md');
  await writeFile(existing, '已有内容');
  // 将文件作为目录能稳定触发写入失败，测试无需改变操作系统权限。
  assert.equal((await post(`${second}/review-directory`, { directory: existing })).status, 303);
  assert.equal((await post(`${second}/transcript`, transcriptFile('二面.txt', FULL_TRANSCRIPT))).status, 303);
  const version = confirmedVersion(await page(second));
  assert.equal((await post(`${second}/review`, { version })).status, 303);
  const failed = await waitFor(page, second, '复盘文件写入失败');
  assert.doesNotMatch(failed, /复盘文件已保存/);
  assert.match(failed, /确认重试复盘/);
  assert.equal(await readFile(existing, 'utf8'), '已有内容');
  assert.deepEqual((await readdir(root)).sort(), ['data', '已有文件.md'].sort());

  assert.equal((await post(`${second}/review-directory`, { directory: root })).status, 303);
  const retry = confirmedVersion(await page(second));
  assert.equal((await post(`${second}/review`, { version: retry })).status, 303);
  const saved = await waitFor(page, second, '复盘文件已保存');
  const file = (await readdir(root)).find(name => name.endsWith('.md') && name !== '已有文件.md');
  assert.ok(file, '重试应创建独立的复盘文件');
  assert.ok(saved.includes(join(root, file)));
  assert.match(await readFile(join(root, file), 'utf8'), /^# 面试复盘/);
  assert.equal(await readFile(existing, 'utf8'), '已有内容');
});
