import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { startApp } from '../src/app.mjs';

const RAW = '姓名：本机合成姓名\n邮箱：local-only@example.org\n生产 Kubernetes 调度与故障处置';
const TECHNICAL = '生产 Kubernetes 调度与故障处置';

async function start(t, { officialCandidates = [], officialPages = {}, matchEvidence = [] } = {}) {
  // 使用固定的 CLI 事件和公开页面，经真实本机 HTTP 路由执行完整操作。
  const dataDir = await mkdtemp(join(tmpdir(), 'job-search-screening-test-'));
  const executable = join(dataDir, 'codex-fixture');
  const capture = join(dataDir, 'calls.jsonl');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'login') {
  console.error('Logged in using ChatGPT');
} else {
  const args = process.argv.slice(2);
  const prompt = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(prompt.split('\\n输入：')[1]);
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, input }) + '\\n');
  const emit = event => console.log(JSON.stringify(event));
  let value;
  if (args.includes('web_search="live"')) {
    const candidates = prompt.startsWith('公司社招官网') ? ${JSON.stringify(officialCandidates)} : [];
    const results = candidates.map(candidate => ({ url: candidate.url, snippet: 'Total lines: 40' }));
    emit({ type: 'item.completed', item: { type: 'web_search',
      action: { type: 'search', queries: ['site:maimai.cn 杭州', 'site:zhipin.com 杭州'] }, results } });
    emit({ type: 'item.completed', item: { type: 'web_search', action: { type: 'open_page' }, results } });
    value = { status: 'completed', candidates };
  } else if (input.jobs) {
    const evidence = ${JSON.stringify(matchEvidence)};
    value = { results: input.jobs.map(job => ({
      id: job.id,
      decision: job.jd.startsWith('方向不匹配') ? 'unmatched' : 'matched',
      evidence: job.jd.startsWith('伪造引用') ? evidence.map(item => ({ ...item, resumeQuote: '简历没有这段证明' })) : evidence,
    })) };
  } else {
    value = { direction: 'Kubernetes 容器平台工程' };
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } });
  emit({ type: 'turn.completed' });
}`, { mode: 0o700 });
  const app = await startApp({ dataDir, port: 0, codexExecutable: executable,
    readOfficialPage: async url => officialPages[url] });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    post(path, fields = {}) {
      return fetch(new URL(path, app.origin), {
        method: 'POST', headers: { Origin: app.origin }, body: new URLSearchParams(fields), redirect: 'manual',
      });
    },
    async page(path) {
      const response = await fetch(new URL(path, app.origin));
      assert.equal(response.status, 200);
      return response.text();
    },
    async calls() {
      return (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    },
  };
}

async function waitFor(app, path, pattern) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = await app.page(path);
    if (pattern.test(page)) return page;
    await pause(25);
  }
  assert.fail(`未在 ${path} 看到 ${pattern}`);
}

function revision(page) {
  return page.match(/name="revision" value="([^"]+)"/)[1];
}

async function saveTechnicalResume(app) {
  assert.equal((await app.post('/settings/resume', { resume: RAW })).status, 303);
  const initial = await app.page('/settings/resume');
  assert.match(initial, /本机合成姓名/);
  const current = revision(initial);
  assert.equal((await app.post('/settings/resume/technical', { revision: current, technical: RAW })).status, 400);
  assert.equal((await app.post('/settings/resume/technical', { revision: current, technical: TECHNICAL })).status, 303);
}

test('JS-05-01 简历只在本机保存，方向提取与公开确认分别提交', async t => {
  const app = await start(t);
  await saveTechnicalResume(app);
  const technicalPage = await app.page('/settings/resume');
  assert.equal((await app.post('/settings/resume/extract', { revision: revision(technicalPage) })).status, 303);
  await waitFor(app, '/settings/resume', /Kubernetes 容器平台工程/);
  assert.equal((await app.post('/search/runs')).status, 400);
  assert.equal((await app.post('/search/direction', { direction: '集群调度平台工程' })).status, 303);
  const run = await app.post('/search/runs');
  await waitFor(app, run.headers.get('location'), /已完成/);

  const calls = await app.calls();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].input, { resume: TECHNICAL });
  assert.ok(calls[0].args.includes('web_search="disabled"'));
  for (const call of calls.slice(1)) {
    assert.deepEqual(Object.keys(call.input).sort(), ['criteria', 'direction']);
    assert.equal(call.input.direction, '集群调度平台工程');
    assert.ok(call.args.includes('web_search="live"'));
  }
  assert.doesNotMatch(JSON.stringify(calls), /本机合成姓名|local-only@example.org/);
});

const DUTY = '负责生产 Kubernetes 集群的资源调度';
const REQUIREMENT = '熟悉 Kubernetes 调度与生产故障处置';

function officialFixtures(jobs) {
  const officialCandidates = jobs.map(({ title, city = '杭州', district = '余杭区', salaryQuote = '人民币 35k–55k/月',
    employer = '合成公司', lead = false }, index) => ({
    title, city, district, salaryQuote, employer, url: `https://careers.example.org/${index}`, jobKey: String(index),
    duties: lead ? [] : [DUTY], requirements: lead ? [] : [REQUIREMENT],
  }));
  const officialPages = Object.fromEntries(officialCandidates.map((job, index) => [
    job.url, `<title>Example · ${job.employer} 招聘</title><header><a href="/"><img alt="${job.employer}"></a></header><main><article><h1>${job.title}</h1>
      <p>招聘主体：${job.employer}</p><p>办公地点：${jobs[index].office ?? job.city + (job.district ?? '')}</p>
      ${job.salaryQuote ? `<p>薪资：${job.salaryQuote}</p>` : ''}
      ${jobs[index].extra ?? ''}
      <h2>岗位职责</h2><p>${DUTY}</p><h2>任职要求</h2><p>${REQUIREMENT}</p>
    </article></main>`,
  ]));
  return { officialCandidates, officialPages };
}

async function runSearch(app) {
  assert.equal((await app.post('/search/direction', { direction: '集群调度平台工程' })).status, 303);
  const response = await app.post('/search/runs');
  assert.equal(response.status, 303);
  return waitFor(app, response.headers.get('location'), /已完成/);
}

function jobLink(page, title) {
  return page.match(new RegExp(`href="(/jobs/[0-9a-f-]+)">${title}</a>`))?.[1];
}

test('JS-05-02 排除已知不符合的 Base、办公区县和薪资，保留办公地点缺失', async t => {
  const app = await start(t, officialFixtures([
    { title: '区间相交岗位' },
    { title: '薪资下限不足', salaryQuote: '人民币 25k–45k/月' },
    { title: '区间不相交', salaryQuote: '人民币 51k–60k/月' },
    { title: '杭州以外岗位', city: '上海', district: '浦东新区' },
    { title: '杭州其他区县', district: '拱墅区' },
    { title: '办公区县未知', district: null },
  ]));
  const run = await runSearch(app);
  const home = await app.page('/');
  for (const page of [home, run]) {
    assert.ok(jobLink(page, '区间相交岗位'));
    assert.ok(jobLink(page, '办公区县未知'));
    assert.doesNotMatch(page, /薪资下限不足|区间不相交|杭州以外岗位|杭州其他区县/);
  }
  assert.match(await app.page(jobLink(home, '办公区县未知')), /办公地点待确认/);
});

test('JS-05-02 按可核实的招聘主体归属筛选，外包岗位按实际签约主体判断', async t => {
  const app = await start(t, officialFixtures([
    { title: '阿里主体岗位', employer: '阿里巴巴' },
    { title: '字节主体岗位', employer: '北京字节跳动科技有限公司' },
    { title: '集团子公司岗位', employer: '合成子公司', extra: '<p>招聘主体归属：字节跳动</p>' },
    { title: '蚂蚁例外岗位', employer: '蚂蚁科技集团股份有限公司', extra: '<p>招聘主体归属：阿里巴巴</p>' },
    { title: '菜鸟例外岗位', employer: '菜鸟网络', extra: '<p>招聘主体归属：阿里巴巴</p>' },
    { title: '外包签约岗位', employer: '字节跳动', extra: '<p>签约主体：合成外包公司</p><p>驻场客户：字节跳动</p>' },
  ]));
  await runSearch(app);
  const home = await app.page('/');
  assert.doesNotMatch(home, /阿里主体岗位|字节主体岗位|集团子公司岗位/);
  for (const title of ['蚂蚁例外岗位', '菜鸟例外岗位', '外包签约岗位']) {
    assert.ok(jobLink(home, title));
  }
  assert.doesNotMatch(await app.page(jobLink(home, '外包签约岗位')), /招聘主体信息有冲突/);
});

test('JS-05-02 外币和非月薪退出筛选，关键字段冲突留给人工确认', async t => {
  const app = await start(t, officialFixtures([
    { title: '外币月薪岗位', salaryQuote: '35k–55k USD/月' },
    { title: '人民币年薪岗位', salaryQuote: '人民币 35万–55万/年' },
    { title: '人民币月薪简写', salaryQuote: '30–50K·14薪' },
    { title: '缺少薪资岗位', salaryQuote: null },
    { title: '薪资冲突岗位', salaryQuote: '25k–45k', extra: '<p>薪酬范围：人民币 35k–55k/月</p>' },
    { title: '地点冲突岗位', extra: '<p>办公地址：上海浦东新区</p>' },
  ]));
  const run = await runSearch(app);
  assert.doesNotMatch(run, /外币月薪岗位|人民币年薪岗位/);
  const cases = [
    ['人民币月薪简写', /简历匹配待确认/],
    ['缺少薪资岗位', /人民币月薪待确认/],
    ['薪资冲突岗位', /月薪信息有冲突，待确认/],
    ['地点冲突岗位', /Base 信息有冲突，待确认/],
  ];
  for (const [title, pattern] of cases) {
    const link = jobLink(run, title);
    assert.ok(link, title);
    const page = await app.page(link);
    assert.match(page, pattern);
    if (title === '人民币月薪简写') assert.doesNotMatch(page, /人民币月薪待确认/);
  }
});

test('JS-05-03 只匹配符合硬条件的核实 JD，引用可回溯并可登记投递', async t => {
  const sources = officialFixtures([
    { title: '两边证据匹配岗位' },
    { title: '伪造引用岗位' },
    { title: '方向不匹配岗位' },
    { title: '只读到摘要的线索', lead: true },
    { title: '硬条件排除岗位', salaryQuote: '25k–45k' },
  ]);
  const matchEvidence = [
    { kind: 'duty', jdQuote: DUTY, resumeQuote: TECHNICAL },
    { kind: 'requirement', jdQuote: REQUIREMENT, resumeQuote: TECHNICAL },
  ];
  const app = await start(t, { ...sources, matchEvidence });
  await saveTechnicalResume(app);
  assert.equal((await app.post('/settings/agent-speed', { speed: 'standard' })).status, 303);
  const run = await runSearch(app);
  const [verified, leads] = run.split('<h2>待核验职位</h2>');
  assert.doesNotMatch(verified, /只读到摘要|方向不匹配|硬条件排除/);
  assert.match(leads, /只读到摘要的线索/);
  const link = jobLink(verified, '两边证据匹配岗位');
  const matched = await app.page(link);
  assert.match(matched, /符合筛选条件/);
  assert.match(matched, /简历匹配依据/);
  assert.ok(matched.includes(`<q>${DUTY}</q>`));
  assert.ok(matched.includes(`<q>${REQUIREMENT}</q>`));
  assert.ok(matched.includes(`<q>${TECHNICAL}</q>`));
  const forged = await app.page(jobLink(verified, '伪造引用岗位'));
  assert.match(forged, /简历匹配待确认/);
  assert.doesNotMatch(forged, /简历匹配依据|简历没有这段证明/);
  const calls = await app.calls();
  assert.equal(calls.length, 4);
  const match = calls[3];
  assert.ok(match.args.includes('web_search="disabled"'));
  assert.ok(match.args.includes('service_tier="default"'));
  assert.equal(match.input.resume, TECHNICAL);
  assert.deepEqual(match.input.jobs.map(job => job.jd.split('\n')[0]), ['两边证据匹配岗位', '伪造引用岗位', '方向不匹配岗位']);
  assert.deepEqual(Object.keys(match.input).sort(), ['jobs', 'resume']);
  assert.ok(match.input.jobs.every(job => Object.keys(job).sort().join() === 'id,jd'));
  assert.doesNotMatch(JSON.stringify(calls), /本机合成姓名|local-only@example.org/);

  assert.equal((await app.post(`${link}/application`)).status, 303);
  assert.match(await app.page(link), /<li>已投递<\/li>/);

  // 招聘页薪资变化后重新筛选，已投递和手动保存的记录继续留在首页。
  const manual = await app.post('/jobs', { jd: '手动留存岗位\n工作地点：北京\n薪资：20k–25k' });
  assert.equal(manual.status, 303);
  const url = sources.officialCandidates[0].url;
  sources.officialPages[url] = sources.officialPages[url].replace('35k–55k', '25k–45k');
  const rerun = await runSearch(app);
  assert.doesNotMatch(rerun, /两边证据匹配岗位/);
  assert.equal(jobLink(await app.page('/'), '两边证据匹配岗位'), link);
  assert.ok(jobLink(await app.page('/'), '手动留存岗位'));
  assert.match(await app.page(link), /<li>已投递<\/li>/);
  assert.match(await app.page(link), /已退出自动筛选/);
});

test('JS-05-03 更新原始简历会停用旧技术文本，历史结果的证据重新标为待确认', async t => {
  const sources = officialFixtures([{ title: '旧简历匹配岗位' }]);
  const app = await start(t, { ...sources, matchEvidence: [
    { kind: 'duty', jdQuote: DUTY, resumeQuote: TECHNICAL },
    { kind: 'requirement', jdQuote: REQUIREMENT, resumeQuote: TECHNICAL },
  ] });
  await saveTechnicalResume(app);
  const oldRevision = revision(await app.page('/settings/resume'));
  await app.post('/search/direction', { direction: '集群调度平台工程' });
  const response = await app.post('/search/runs');
  const runPath = response.headers.get('location');
  const run = await waitFor(app, runPath, /已完成/);
  const link = jobLink(run, '旧简历匹配岗位');
  assert.match(await app.page(link), /简历匹配依据/);
  assert.match(run, /符合筛选条件/);

  assert.equal((await app.post('/settings/resume', { resume: '姓名：新合成姓名\n运维监控经验' })).status, 303);
  assert.equal((await app.post('/settings/resume/extract', { revision: oldRevision })).status, 409);
  assert.doesNotMatch(await app.page('/settings/resume'), /已确认去标识技术文本|本机合成姓名/);
  const detail = await app.page(link);
  assert.match(detail, /简历已更新，匹配待重新确认/);
  assert.doesNotMatch(detail, /简历匹配依据|符合筛选条件/);
  assert.doesNotMatch(await app.page(runPath), /符合筛选条件/);
  await runSearch(app);
  assert.equal((await app.calls()).filter(call => call.input.jobs).length, 1);
});

test('明确 Base 和实际办公区县独立筛选，Base 中的区县不能代替办公地址', async t => {
  const app = await start(t, officialFixtures([
    { title: '上海 Base 杭州办公', extra: '<p>Base：上海</p>' },
    { title: '杭州 Base 上海办公', city: '上海', district: '浦东新区', extra: '<p>Base：杭州</p>' },
    { title: '杭州 Base 南昌西湖办公', city: '杭州', district: null, extra: '<p>Base：杭州</p><p>办公地址：南昌西湖区</p>', office: '南昌西湖区' },
    { title: '杭州 Base 余杭办公', extra: '<p>Base：杭州西湖区</p>' },
  ]));
  const page = await runSearch(app);
  assert.doesNotMatch(page, /上海 Base 杭州办公|杭州 Base 上海办公|杭州 Base 南昌西湖办公/);
  const detail = await app.page(jobLink(page, '杭州 Base 余杭办公'));
  assert.doesNotMatch(detail, /办公地点信息有冲突|办公地点待确认|Base 信息有冲突/);
});
