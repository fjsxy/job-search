import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp } from '../src/app.mjs';

function clockAt(time) {
  let now = Date.parse(time);
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const handle = Symbol();
      timers.set(handle, { callback, due: now + delay });
      return handle;
    },
    clearTimeout: handle => timers.delete(handle),
    async advanceTo(time) {
      now = Date.parse(time);
      // 模拟时钟跳转或唤醒，只唤醒到期的现有定时器。
      for (const [handle, { callback, due }] of [...timers]) {
        if (now < due) continue;
        timers.delete(handle);
        callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

async function fixture(t, initialTime, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'job-search-scheduled-test-'));
  const searchClock = clockAt(initialTime);
  const calls = [];
  const subscription = {
    async run(args) {
      calls.push(args.prompt.split('\n', 1)[0]);
      if (options.run) return options.run(args);
      return emptyResults();
    },
  };
  let app;
  const stop = async () => {
    if (!app) return;
    await app.close();
    app = undefined;
  };
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    calls, searchClock, stop,
    async boot() {
      app = await startApp({ dataDir, port: 0, searchClock, subscription, readOfficialPage: options.readPage });
    },
    post(path, fields = {}) {
      return fetch(app.origin + path, {
        method: 'POST', headers: { Origin: app.origin }, body: new URLSearchParams(fields), redirect: 'manual',
      });
    },
    async page(path) {
      const response = await fetch(app.origin + path);
      assert.equal(response.status, 200);
      return response.text();
    },
  };
}

function emptyResults() {
  return {
    value: { status: 'completed', candidates: [] },
    webEvidence: [{ action: { type: 'search', queries: ['site:maimai.cn 杭州', 'site:zhipin.com 杭州'] }, results: [] }],
  };
}

function runLinks(page) {
  return [...page.matchAll(/href="(\/search\/runs\/[0-9a-f-]+)"/g)].map(match => match[1]);
}

test('JS-08-01 北京时间 09:30 无页面会话时触发一次，之后可查看三个来源状态', async t => {
  const app = await fixture(t, '2026-11-06T09:29:30+08:00');
  await app.boot();
  assert.equal((await app.post('/search/direction', { direction: '容器平台工程' })).status, 303);
  await app.stop();

  // 从实际启动入口恢复应用。到达计划时间前后都不发页面请求。
  await app.boot();
  await app.searchClock.advanceTo('2026-11-06T09:29:59+08:00');
  assert.deepEqual(app.calls, []);
  await app.searchClock.advanceTo('2026-11-06T09:30:00+08:00');
  assert.deepEqual(app.calls.sort(), ['BOSS 直聘', '公司社招官网', '脉脉']);
  await app.searchClock.advanceTo('2026-11-06T09:31:00+08:00');
  assert.equal(app.calls.length, 3);

  const [path, duplicate] = runLinks(await app.page('/search'));
  assert.equal(duplicate, undefined);
  const result = await app.page(path);
  assert.match(result, /定时搜索.*2026-11-06/);
  for (const source of app.calls) assert.ok(result.includes(`${source} · 已完成 · 零结果`));
});

test('缺少公开岗位方向时，定时失败持久可见并可在配置后手动重跑', async t => {
  const app = await fixture(t, '2026-11-06T09:35:00+08:00');
  await app.boot();
  const paths = runLinks(await app.page('/search'));
  assert.equal(paths.length, 1);
  const [failed] = paths;
  assert.match(await app.page(failed), /搜索 · 失败[\s\S]*请先确认岗位方向[\s\S]*重新搜索/);
  assert.deepEqual(app.calls, []);
  assert.equal((await app.post('/search/runs')).status, 400);

  await app.stop();
  await app.boot();
  assert.deepEqual(runLinks(await app.page('/search')), [failed]);
  assert.equal((await app.post('/search/direction', { direction: '容器平台工程' })).status, 303);
  await app.searchClock.advanceTo('2026-11-06T09:36:00+08:00');
  assert.deepEqual(app.calls, []);
  assert.deepEqual(runLinks(await app.page('/search')), [failed]);

  const retry = await app.post('/search/runs');
  assert.equal(retry.status, 303);
  const retried = retry.headers.get('location');
  assert.notEqual(retried, failed);
  assert.match(await app.page(retried), /搜索 · 已完成/);
  assert.match(await app.page(failed), /搜索 · 失败/);
});

test('JS-08-02 停机跨日后只搜索恢复当天，第二天继续按时运行', async t => {
  const app = await fixture(t, '2026-11-06T09:29:00+08:00');
  await app.boot();
  assert.equal((await app.post('/search/direction', { direction: '容器平台工程' })).status, 303);
  await app.stop();

  await app.searchClock.advanceTo('2026-11-09T15:45:00+08:00');
  assert.deepEqual(app.calls, []);
  await app.boot();
  const restored = runLinks(await app.page('/search'));
  assert.equal(restored.length, 1);
  assert.match(await app.page(restored[0]), /已完成.*北京时间 2026-11-09/);
  assert.equal(app.calls.length, 3);

  await app.stop();
  await app.boot();
  assert.deepEqual(runLinks(await app.page('/search')), restored);
  await app.searchClock.advanceTo('2026-11-10T09:29:00+08:00');
  assert.deepEqual(runLinks(await app.page('/search')), restored);
  assert.equal(app.calls.length, 3);

  await app.searchClock.advanceTo('2026-11-10T09:30:00+08:00');
  const next = runLinks(await app.page('/search'));
  assert.equal(next.length, 2);
  assert.equal(next[1], restored[0]);
  assert.match(await app.page(next[0]), /已完成.*北京时间 2026-11-10/);
  assert.equal(app.calls.length, 6);
});

test('09:30 遇到手动搜索正在运行时，共用该次搜索满足当日计划', async t => {
  const turn = Promise.withResolvers();
  const app = await fixture(t, '2026-11-06T09:29:00+08:00', {
    async run({ signal }) {
      await Promise.race([
        turn.promise,
        new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
      ]);
      return emptyResults();
    },
  });
  await app.boot();
  assert.equal((await app.post('/search/direction', { direction: '容器平台工程' })).status, 303);

  const response = await app.post('/search/runs');
  assert.equal(response.status, 303);
  const path = response.headers.get('location');
  assert.match(await app.page(path), /搜索 · 进行中/);
  await app.searchClock.advanceTo('2026-11-06T09:30:00+08:00');
  assert.match(await app.page(path), /搜索 · 进行中.*北京时间 2026-11-06/);
  turn.resolve();

  await app.searchClock.advanceTo('2026-11-06T09:31:00+08:00');
  assert.deepEqual(runLinks(await app.page('/search')), [path]);
  assert.match(await app.page(path), /搜索 · 已完成/);
  assert.equal(app.calls.length, 3);
});

const EMPLOYER = '杭州合成科技有限公司';
const DUTY = '维护生产 Kubernetes 集群';
const REQUIREMENT = '掌握 Go 与 Linux';
const TECHNICAL = '维护生产 Kubernetes 集群，掌握 Go 与 Linux';
const CANDIDATES = {
  公司社招官网: {
    title: '平台工程师', url: 'https://careers.example.org/jobs/PL-101', jobKey: 'PL-101', salaryQuote: '人民币 35k–45k/月',
  },
  脉脉: {
    title: '平台工程师', url: 'https://maimai.cn/jobs/job_detail?ejid=abc', jobKey: 'PL-101', salaryQuote: '人民币 35k–45k/月',
  },
  'BOSS 直聘': {
    title: '低于月薪门槛', url: 'https://www.zhipin.com/job_detail/example.html', jobKey: 'PL-102', salaryQuote: '人民币 25k–45k/月',
  },
};

test('JS-08-03 定时搜索与同时触发的手动搜索共用任务，失败后可重跑且保留唯一职位和投递', async t => {
  const failedTurn = Promise.withResolvers();
  let shouldFail = true;
  const app = await fixture(t, '2026-11-06T09:29:00+08:00', {
    async run({ prompt, signal, webSearch }) {
      if (!webSearch) {
        const { resume, jobs } = JSON.parse(prompt.split('\n输入：')[1]);
        assert.equal(resume, TECHNICAL);
        assert.equal(jobs.length, 2);
        return { value: { results: jobs.map(({ id }) => ({
          id, decision: 'matched', evidence: [
            { kind: 'duty', jdQuote: DUTY, resumeQuote: DUTY },
            { kind: 'requirement', jdQuote: REQUIREMENT, resumeQuote: REQUIREMENT },
          ],
        })) } };
      }
      if (shouldFail) {
        await Promise.race([
          failedTurn.promise,
          new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
        ]);
        throw new Error('合成订阅失败');
      }
      const candidate = CANDIDATES[prompt.split('\n', 1)[0]];
      const evidence = [{ url: candidate.url, snippet: 'Total lines: 30' }];
      return {
        value: { status: 'completed', candidates: [{
          ...candidate, employer: EMPLOYER, city: '杭州', district: '余杭区', duties: [DUTY], requirements: [REQUIREMENT],
        }] },
        webEvidence: [
          { action: { type: 'search', queries: ['site:maimai.cn 杭州', 'site:zhipin.com 杭州'] }, results: evidence },
          { action: { type: 'open_page' }, results: evidence },
        ],
      };
    },
    readPage: async url => {
      const job = Object.values(CANDIDATES).find(candidate => candidate.url === url);
      return `<title>Example · ${EMPLOYER} 招聘</title><header><a href="/"><img alt="${EMPLOYER}"></a></header><article><h1>${job.title}</h1>
        <p>招聘主体：${EMPLOYER}</p><p>办公地点：杭州余杭区</p><p>月薪：${job.salaryQuote}</p>
        <p>招聘编号：${job.jobKey}</p><h2>岗位职责</h2><p>${DUTY}</p><h2>任职要求</h2><p>${REQUIREMENT}</p></article>`;
    },
  });
  await app.boot();
  assert.equal((await app.post('/settings/resume', { resume: '姓名：合成用户\n' + TECHNICAL })).status, 303);
  const revision = (await app.page('/settings/resume')).match(/name="revision" value="([^"]+)"/)[1];
  assert.equal((await app.post('/settings/resume/technical', { technical: TECHNICAL, revision })).status, 303);
  assert.equal((await app.post('/search/direction', { direction: '容器平台工程' })).status, 303);
  const imported = await app.post('/jobs', { jd: `平台工程师\n招聘主体：${EMPLOYER}\n招聘编号：PL-101` });
  assert.equal(imported.status, 303);
  const jobPath = imported.headers.get('location');
  assert.equal((await app.post(`${jobPath}/application`)).status, 303);
  assert.equal((await app.post(`${jobPath}/application/interviews`, { result: 'passed' })).status, 303);

  await app.searchClock.advanceTo('2026-11-06T09:30:00+08:00');
  const [failed] = runLinks(await app.page('/search'));
  assert.match(await app.page(failed), /搜索 · 进行中/);
  const manual = await Promise.all([app.post('/search/runs'), app.post('/search/runs')]);
  for (const response of manual) {
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), failed);
  }
  assert.equal(app.calls.length, 3);
  failedTurn.resolve();
  assert.match(await app.page(failed), /搜索 · 失败[\s\S]*来源状态[\s\S]*重新搜索/);

  shouldFail = false;
  const retry = await app.post('/search/runs');
  assert.equal(retry.status, 303);
  const retried = retry.headers.get('location');
  assert.notEqual(retried, failed);

  async function assertSuccess(path) {
    const page = await app.page(path);
    assert.match(page, /搜索 · 已完成/);
    for (const source of Object.keys(CANDIDATES)) assert.ok(page.includes(`${source} · 已完成 · 1 条已核实 JD`));
    assert.doesNotMatch(page, /低于月薪门槛/);
    const visible = [...(await app.page('/')).matchAll(/href="(\/jobs\/[0-9a-f-]+)">平台工程师<\/a>/g)];
    assert.deepEqual(visible.map(match => match[1]), [jobPath]);
    const detail = await app.page(jobPath);
    assert.match(detail, /简历匹配依据/);
    assert.match(detail, /已投递[\s\S]*一面通过/);
    assert.equal(detail.match(/>已投递</g)?.length, 1);
    assert.ok(detail.includes(CANDIDATES.公司社招官网.url) && detail.includes(CANDIDATES.脉脉.url));
  }
  await assertSuccess(retried);

  await app.searchClock.advanceTo('2026-11-07T09:30:00+08:00');
  const [scheduled] = runLinks(await app.page('/search'));
  assert.notEqual(scheduled, retried);
  assert.match(await app.page(scheduled), /定时搜索.*2026-11-07/);
  await assertSuccess(scheduled);
});
