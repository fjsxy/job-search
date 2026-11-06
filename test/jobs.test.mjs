import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
