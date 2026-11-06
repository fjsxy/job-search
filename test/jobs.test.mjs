import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

async function testServer(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'job-search-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const { startApp } = await import('../src/app.mjs');
  return {
    async start() {
      app = await startApp({ dataDir, port: 0 });
      return app.origin;
    },
    async stop() {
      await app.close();
      app = undefined;
    },
  };
}

async function openApp(t) {
  const server = await testServer(t);
  return server.start();
}

test('JS-02-01 首页可打开并提供 JD 导入入口', async (t) => {
  const origin = await openApp(t);
  const response = await fetch(origin);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const page = await response.text();
  assert.match(page, /手动导入/);
  assert.match(page, /<textarea[^>]*name="jd"/);
});

function submit(origin, path, fields) {
  return fetch(new URL(path, origin), {
    method: 'POST',
    headers: { Origin: origin },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

async function registerJob(origin, jd = '平台工程师\n负责 Kubernetes 平台') {
  const saved = await submit(origin, '/jobs', { jd });
  assert.equal(saved.status, 303);
  const jobPath = saved.headers.get('location');
  assert.equal((await submit(origin, `${jobPath}/application`, {})).status, 303);
  return jobPath;
}

async function openPage(origin, path) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200);
  return response.text();
}

function roundLink(page, label) {
  const link = page.match(new RegExp(`<a href="([^"]+)">${label}</a>`));
  assert.ok(link, `投递应提供${label}的入口`);
  return link[1];
}

test('JS-03-01 从投递录入一面预约，调整时间并更新为通过', async (t) => {
  const origin = await openApp(t);
  const jobPath = await registerJob(origin);
  const createPath = `${jobPath}/application/interviews`;
  assert.ok((await openPage(origin, jobPath)).includes(`<form action="${createPath}"`));

  const created = await submit(origin, createPath, { scheduledAt: '2026-11-09T09:30' });
  assert.equal(created.status, 303);
  const roundPath = roundLink(await openPage(origin, jobPath), '一面');
  assert.match(await openPage(origin, roundPath), /value="2026-11-09T09:30"/);

  const updated = await submit(origin, roundPath, { scheduledAt: '2026-11-10T14:45', result: 'passed' });
  assert.equal(updated.status, 303);
  assert.match(await openPage(origin, jobPath), /当前进度：一面通过/);
  assert.match(await openPage(origin, roundPath), /value="2026-11-10T14:45"/);
});

test('JS-03-02 手动推进到二面，重启后保留两轮的进展', async (t) => {
  const server = await testServer(t);
  let origin = await server.start();
  const jobPath = await registerJob(origin);
  const createPath = `${jobPath}/application/interviews`;
  assert.equal((await submit(origin, createPath, { result: 'passed' })).status, 303);
  let detail = await openPage(origin, jobPath);
  assert.match(detail, /当前进度：一面通过/);
  const firstRound = roundLink(detail, '一面');

  const scheduledAt = '2026-11-12T09:30';
  assert.equal((await submit(origin, createPath, { scheduledAt })).status, 303);
  detail = await openPage(origin, jobPath);
  assert.match(detail, /当前进度：二面 · 2026-11-12 09:30（北京时间）/);
  const secondRound = roundLink(detail, '二面');
  assert.equal((await submit(origin, secondRound, { scheduledAt, result: 'failed' })).status, 303);

  // 通过服务重启后的同一个职位详情验证轮次归属和持久化。
  await server.stop();
  origin = await server.start();
  detail = await openPage(origin, jobPath);
  assert.match(detail, /当前进度：二面不通过/);
  assert.equal(roundLink(detail, '一面'), firstRound);
  assert.equal(roundLink(detail, '二面'), secondRound);
  assert.match(await openPage(origin, firstRound), /value="passed" selected>通过/);
  const secondDetail = await openPage(origin, secondRound);
  assert.match(secondDetail, /value="failed" selected>不通过/);
  assert.match(secondDetail, /value="2026-11-12T09:30"/);
});

test('JS-03-03 拒绝非法预约、非法结果和跨投递的轮次操作', async (t) => {
  const origin = await openApp(t);
  const jobPath = await registerJob(origin);
  const otherJob = await registerJob(origin, '另一职位');
  const createPath = `${jobPath}/application/interviews`;
  const scheduledAt = '2026-11-12T09:30';
  assert.equal((await submit(origin, createPath, { scheduledAt, result: 'passed' })).status, 303);
  const roundPath = roundLink(await openPage(origin, jobPath), '一面');

  const invalidTime = await submit(origin, roundPath, { scheduledAt: '2026-02-30T09:30', result: 'failed' });
  assert.equal(invalidTime.status, 400);
  assert.match(await invalidTime.text(), /请输入有效的预约时间/);

  const invalidResult = await submit(origin, roundPath, { scheduledAt, result: '未知' });
  assert.equal(invalidResult.status, 400);
  assert.match(await invalidResult.text(), /请选择有效的面试结果/);

  const emptyRound = await submit(origin, createPath, {});
  assert.equal(emptyRound.status, 400);
  assert.match(await emptyRound.text(), /请填写预约时间或选择面试结果/);

  const otherPath = roundPath.replace(jobPath, otherJob);
  const otherDetail = await fetch(new URL(otherPath, origin));
  assert.equal(otherDetail.status, 404);
  const otherUpdate = await submit(origin, otherPath, { result: 'failed' });
  assert.equal(otherUpdate.status, 404);
  assert.match(await otherUpdate.text(), /面试轮次不存在/);

  assert.match(await openPage(origin, jobPath), /当前进度：一面通过/);
  assert.match(await openPage(origin, roundPath), /value="2026-11-12T09:30"/);
  assert.match(await openPage(origin, otherJob), /当前进度：尚无面试记录/);
});

test('JS-02-02 手动导入保留不符合自动筛选条件的 JD 正文', async (t) => {
  const origin = await openApp(t);
  const jd = '后端工程师\n办公地点：上海\n月薪：20k–25k\n  职责：维护 API <script>alert(1)</script> & 文档  ';
  const saved = await submit(origin, '/jobs', { jd });

  assert.equal(saved.status, 303);
  const detailPath = saved.headers.get('location');
  const list = await fetch(origin);
  assert.ok((await list.text()).includes(`href="${detailPath}">后端工程师</a>`));

  const detail = await fetch(new URL(detailPath, origin));
  assert.equal(detail.status, 200);
  const page = await detail.text();
  assert.ok(page.includes('后端工程师\n办公地点：上海\n月薪：20k–25k\n  职责：维护 API &lt;script&gt;alert(1)&lt;/script&gt; &amp; 文档  '));
  assert.doesNotMatch(page, /<script>/);
});

test('JS-02-03 重复确认仍只有一条投递，服务重启后可再次查看', async (t) => {
  const server = await testServer(t);
  let origin = await server.start();
  const jd = '平台工程师\n负责 Kubernetes 平台';
  const saved = await submit(origin, '/jobs', { jd });
  const detailPath = saved.headers.get('location');
  const firstDetail = await fetch(new URL(detailPath, origin));
  assert.match(await firstDetail.text(), /确认已投递/);

  const applicationPath = `${detailPath}/application`;
  const responses = await Promise.all([
    submit(origin, applicationPath, {}),
    submit(origin, applicationPath, {}),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), detailPath);
  }

  await server.stop();
  origin = await server.start();

  const list = await fetch(origin);
  assert.ok((await list.text()).includes(`href="${detailPath}">平台工程师</a>`));
  const detail = await fetch(new URL(detailPath, origin));
  assert.equal(detail.status, 200);
  const page = await detail.text();
  assert.ok(page.includes(jd));
  assert.equal(page.match(/<li>已投递<\/li>/g)?.length, 1);
  assert.doesNotMatch(page, /确认已投递/);
});

test('本机界面拒绝跨来源提交', async (t) => {
  const origin = await openApp(t);
  const request = await fetch(new URL('/jobs', origin), {
    method: 'POST',
    headers: { Origin: 'https://outside.example' },
    body: new URLSearchParams({ jd: '跨来源提交的 JD' }),
    redirect: 'manual',
  });

  assert.equal(request.status, 403);
  const list = await fetch(origin);
  assert.doesNotMatch(await list.text(), /跨来源提交的 JD/);
});

test('本机界面拒绝意外的 Host', async (t) => {
  const origin = await openApp(t);
  const status = await new Promise((resolve, reject) => {
    get(origin, { headers: { Host: 'outside.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });

  assert.equal(status, 421);
});

test('自定义数据目录保留权限，SQLite 主文件与事务文件仅本机用户可读写', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'job-search-modes-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = join(parent, 'custom');
  await mkdir(dataDir);
  await chmod(dataDir, 0o755);
  const file = join(dataDir, 'job-search.sqlite');
  const { startApp } = await import('../src/app.mjs');
  const app = await startApp({ dataDir, port: 0 });
  t.after(() => app.close());
  assert.equal((await stat(dataDir)).mode & 0o777, 0o755);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const db = new DatabaseSync(file);
  try {
    // 打开实际回滚事务，在 SQLite 删除 sidecar 前检查其权限。
    db.exec('BEGIN IMMEDIATE; CREATE TABLE test_permissions (id INTEGER)');
    assert.equal((await stat(file + '-journal')).mode & 0o777, 0o600);
    db.exec('ROLLBACK; PRAGMA journal_mode = WAL; CREATE TABLE test_permissions (id INTEGER)');
    for (const suffix of ['-wal', '-shm']) {
      assert.equal((await stat(file + suffix)).mode & 0o777, 0o600);
    }
  } finally {
    db.close();
  }
});

test('启动时收紧旧数据库权限，拒绝指向其他文件的主文件或 sidecar', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'job-search-modes-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const file = join(parent, 'job-search.sqlite');
  const { startApp } = await import('../src/app.mjs');
  const original = await startApp({ dataDir: parent, port: 0 });
  const jobPath = await registerJob(original.origin);
  await original.close();
  await chmod(file, 0o644);
  const reopened = await startApp({ dataDir: parent, port: 0 });
  try {
    assert.match(await openPage(reopened.origin, jobPath), /已投递/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await reopened.close();
  }

  const other = join(parent, 'other');
  await writeFile(other, '另一个本机文件', { mode: 0o644 });
  for (const suffix of ['-journal', '-wal', '-shm', '']) {
    if (!suffix) await rm(file);
    const unsafe = file + suffix;
    await (suffix === '-wal' ? link : symlink)(other, unsafe);
    await assert.rejects(startApp({ dataDir: parent, port: 0 }));
    assert.equal(await readFile(other, 'utf8'), '另一个本机文件');
    assert.equal((await stat(other)).mode & 0o777, 0o644);
    await rm(unsafe);
  }
});

test('两份手动 JD 按唯一招聘编号合并，原文和投递轮次均保留', async t => {
  const origin = await openApp(t);
  const job = '平台工程师\n招聘主体：合成科技\n招聘编号：JOB-1\n职责：原 JD 文本';
  const path = await registerJob(origin, job);
  assert.equal((await submit(origin, `${path}/application/interviews`, { result: 'passed' })).status, 303);
  const update = job.replace('原 JD 文本', '新 JD 文本');
  const second = await submit(origin, '/jobs', { jd: update });
  assert.equal(second.status, 303);
  assert.equal(second.headers.get('location'), path);
  assert.equal((await submit(origin, `${path}/application`, {})).status, 303);
  const detail = await openPage(origin, path);
  assert.match(detail, /原 JD 文本[\s\S]*新 JD 文本/);
  assert.match(detail, /当前进度：一面通过/);
  assert.equal((detail.match(/<li>已投递<\/li>/g) ?? []).length, 1);
  const distinct = await submit(origin, '/jobs', { jd: update.replace('合成科技', '另一家公司') });
  assert.notEqual(distinct.headers.get('location'), path);
  const anonymous = await submit(origin, '/jobs', { jd: update.replace('招聘编号：JOB-1\n', '') });
  assert.notEqual(anonymous.headers.get('location'), path);
});

test('JS-07-07 手动 JD 只按发布招聘主体的明确编号合并', async t => {
  const origin = await openApp(t);
  const jd = '平台工程师\n招聘主体：甲科技\n签约主体：合成外包公司\n招聘编号：123\n职责：维护生产集群';
  const add = async text => (await submit(origin, '/jobs', { jd: text })).headers.get('location');
  const first = await add(jd);
  assert.notEqual(await add(jd.replace('甲科技', '乙科技')), first);
  assert.equal(await add(jd.replace('合成外包公司', '更新后的签约公司')), first);
  const unnamed = jd.replace('招聘主体：甲科技\n', '');
  assert.notEqual(await add(unnamed), await add(unnamed));
});
