import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { startApp } from '../src/app.mjs';

function post(origin, path, fields = {}) {
  return fetch(new URL(path, origin), {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams(fields), redirect: 'manual',
  });
}

async function readPage(origin, path) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200);
  return response.text();
}

async function waitForRun(origin, path, pattern) {
  assert.ok(path);
  for (let count = 0; count < 120; count++) {
    const page = await readPage(origin, path);
    if (pattern.test(page)) return page;
    await pause(25);
  }
  assert.fail('未在状态页看到预期结果');
}

async function fixture(t, events, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'job-search-test-'));
  const executable = join(dataDir, 'codex-fixture');
  const captured = join(dataDir, 'captured.jsonl');
  const replies = join(dataDir, 'replies.json');
  await writeFile(replies, JSON.stringify(events));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'login') {
  console.error('Logged in using ChatGPT');
} else {
  const record = { args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') };
  fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify(record) + '\\n');
  const official = record.input.startsWith('公司社招官网');
  const emptyBoard = ${JSON.stringify(success().map(event => event.item?.type === 'web_search'
    ? { ...event, item: { ...event.item, action: { type: 'search', queries: ['site:maimai.cn 杭州', 'site:zhipin.com 杭州'] } } }
    : event))};
  const events = official ? JSON.parse(fs.readFileSync(${JSON.stringify(replies)}, 'utf8')) : emptyBoard;
  for (const event of events) {
    console.log(JSON.stringify(event));
  }
}`, { mode: 0o700 });
  const app = await startApp({ dataDir, port: 0, codexExecutable: executable, ...options });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { origin: app.origin, captured, replies };
}

function success(candidates = []) {
  return [
    { type: 'item.completed', item: { type: 'web_search', action: { type: 'search' }, results: [] } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'completed', candidates }) } },
    { type: 'turn.completed' },
  ];
}

test('JS-04-01 官网搜索只发送确认方向和筛选条件，并统一使用两档订阅设置', async (t) => {
  const { origin, captured } = await fixture(t, success());
  assert.match(await readPage(origin, '/search'), /Fast/);
  assert.equal((await post(origin, '/search/runs')).status, 400);
  assert.equal((await post(origin, '/jobs', { jd: '本机手动 JD 独有内容' })).status, 303);
  assert.equal((await post(origin, '/search/direction', { direction: '容器平台工程', resume: '本机简历独有内容' })).status, 303);

  const fast = await post(origin, '/search/runs', { prompt: '本机任意提示词' });
  await waitForRun(origin, fast.headers.get('location'), /已完成/);
  assert.equal((await post(origin, '/settings/agent-speed', { speed: 'standard' })).status, 303);
  const standard = await post(origin, '/search/runs');
  await waitForRun(origin, standard.headers.get('location'), /已完成/);

  const calls = (await readFile(captured, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(({ args }) => args.includes('service_tier="fast"')).length, 3);
  assert.equal(calls.filter(({ args }) => args.includes('service_tier="default"')).length, 3);
  for (const { args, input } of calls) {
    for (const arg of ['gpt-6.1-sol', 'forced_login_method="chatgpt"', 'model_reasoning_effort="xhigh"', 'web_search="live"']) {
      assert.ok(args.includes(arg), arg);
    }
    const fields = JSON.parse(input.split('\n输入：')[1]);
    assert.deepEqual(fields, {
      direction: '容器平台工程',
      criteria: {
        base: '杭州', officeDistricts: ['余杭区', '西湖区'],
        excludedEmployers: ['阿里巴巴', '字节跳动'], employerExceptions: ['蚂蚁', '菜鸟'],
        monthlySalaryCnyThousands: { minimum: 30, intersects: [30, 50] },
      },
    });
    assert.doesNotMatch(input, /本机手动 JD 独有内容|本机简历独有内容|本机任意提示词/);
  }
});

test('JS-04-02 官网原文进入统一职位视图，摘要及无法佐证的结果留在待核验', async (t) => {
  const url = 'https://careers.example.org/positions/cloud';
  const summaryUrl = 'https://careers.example.org/positions/infra';
  const unverifiableUrl = 'https://careers.example.org/positions/gateway';
  const candidate = {
    url, title: '平台工程师', employer: '合成公司', city: '杭州', district: '余杭区',
    salaryQuote: '人民币 35k–50k/月', jobKey: 'cloud',
    duties: ['维护杭州生产 Kubernetes 集群'],
    requirements: ['精通 Go 与容器调度'],
  };
  const evidence = success([
    candidate, { ...candidate, url: summaryUrl, title: '摘要岗位' },
    { ...candidate, url: unverifiableUrl, title: '无可佐证正文', duties: ['从未在原网页出现的职责'] },
  ]);
  evidence[0].item.results = [url, summaryUrl, unverifiableUrl].map(link => ({ url: link, snippet: '搜索摘要' }));
  evidence.unshift({ type: 'item.completed', item: {
    type: 'web_search', action: { type: 'open_page' },
    results: [url, unverifiableUrl].map(link => ({ url: link, snippet: 'Total lines: 45' })),
  } });
  const pageFor = async (link) => {
    if (link === summaryUrl) return '<title>摘要岗位</title><p>只有职位摘要</p><a href="/login">登录</a>';
    return `<title>Example · 合成公司官网招聘</title><header><a href="/"><img alt="合成公司"></a></header><main><article>
      <h1>${link === url ? '平台工程师' : '无可佐证正文'}</h1>
      <p>招聘主体：合成公司</p><p>办公地点：杭州余杭区</p><p>薪资：人民币 35k–50k/月</p>
      <h2>岗位职责</h2><ul><li>维护杭州生产 Kubernetes 集群</li><li>完善跨集群网络的演练流程</li></ul>
      <h2>任职要求</h2><ul><li>精通 Go 与容器调度</li><li>能为生产故障组织跨团队排查</li></ul>
    </article></main>`;
  };
  const { origin } = await fixture(t, evidence, { readOfficialPage: pageFor });
  await post(origin, '/search/direction', { direction: '云平台工程' });
  const run = await post(origin, '/search/runs');
  const runPage = await waitForRun(origin, run.headers.get('location'), /已完成/);

  const [verified, leads] = runPage.split('<h2>待核验职位</h2>');
  assert.match(verified, /平台工程师/);
  assert.match(leads, /摘要岗位/);
  assert.match(leads, /无可佐证正文/);
  assert.doesNotMatch(leads, /平台工程师/);

  const homepage = await readPage(origin, '/');
  const detailPath = homepage.match(/href="(\/jobs\/[0-9a-f-]+)">平台工程师/)[1];
  const detail = await readPage(origin, detailPath);
  assert.match(detail, /维护杭州生产 Kubernetes 集群/);
  assert.match(detail, /完善跨集群网络的演练流程/);
  assert.match(detail, /能为生产故障组织跨团队排查/);
  assert.ok(detail.includes(url));
  assert.doesNotMatch(homepage, /摘要岗位|无可佐证正文/);

  const rerun = await post(origin, '/search/runs');
  await waitForRun(origin, rerun.headers.get('location'), /已完成/);
  assert.equal((await readPage(origin, '/')).match(/>平台工程师<\/a>/g).length, 1);
});

test('JS-04-03 可查看订阅失败并从结果页重跑', async (t) => {
  const { origin, replies } = await fixture(t, [{ type: 'turn.failed', error: { message: '订阅内部诊断' } }]);
  await post(origin, '/search/direction', { direction: '云平台工程' });
  const failed = await post(origin, '/search/runs');
  const failedPath = failed.headers.get('location');
  const failedPage = await waitForRun(origin, failedPath, /官网 · 失败/);
  assert.match(failedPage, /重新搜索/);
  assert.doesNotMatch(failedPage, /订阅内部诊断/);

  await writeFile(replies, JSON.stringify(success()));
  const retried = await post(origin, '/search/runs');
  assert.notEqual(retried.headers.get('location'), failedPath);
  const newPage = await waitForRun(origin, retried.headers.get('location'), /已完成/);
  assert.match(newPage, /本次没有核实的 JD/);
  assert.match(await readPage(origin, failedPath), /官网 · 失败/);
});
