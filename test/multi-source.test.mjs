import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { startApp } from '../src/app.mjs';

const company = 'Example 杭州合成科技有限公司';
const official = 'https://careers.example.org/jobs/PL-101';
const maimai = 'https://maimai.cn/jobs/job_detail?ejid=abc';
const boss = 'https://www.zhipin.com/job_detail/example.html';

function candidate(url, title = '平台工程师', extra = {}) {
  return {
    url, title, employer: company, city: '杭州', district: '余杭区', salaryQuote: '人民币 35k–45k/月',
    jobKey: null, duties: ['维护生产 Kubernetes 集群'], requirements: ['掌握 Go 与 Linux'], ...extra,
  };
}

function html(job, { id, extra = '', siteLogo = true } = {}) {
  return `<title>${job.employer} 招聘</title>
  ${siteLogo ? `<header><a href="/"><img alt="${job.employer}"></a></header>` : ''}<article><h1>${job.title}</h1>
  <p>招聘主体：${job.employer}</p><p>办公地点：${job.city}${job.district}</p><p>月薪：${job.salaryQuote}</p>
  ${id ? `<p>招聘编号：${id}</p>` : ''}${extra}
  <h2>岗位职责</h2><ul><li>${job.duties[0]}</li></ul>
  <h2>任职要求</h2><ul><li>${job.requirements[0]}</li></ul></article>`;
}

function result(candidates = [], { status = 'completed', unreadable = [] } = {}) {
  return {
    value: { candidates, status },
    webEvidence: [
      { action: { type: 'search', queries: ['site:maimai.cn 容器平台', 'site:zhipin.com 容器平台'] }, results: candidates.map(({ url }) => ({ url, snippet: '公开索引摘要' })) },
      { action: { type: 'open_page' }, results: candidates.filter(({ url }) => !unreadable.includes(url))
        .map(({ url }) => ({ url, snippet: 'Total lines: 50' })) },
    ],
  };
}

async function fixture(t, replies, pages, match) {
  const dataDir = await mkdtemp(join(tmpdir(), 'job-search-test-'));
  const app = await startApp({
    dataDir, port: 0,
    subscription: {
      async run({ prompt, webSearch }) {
        if (!webSearch && match) return match(JSON.parse(prompt.split("\n输入：")[1]));
        const source = prompt.split('\n')[0];
        return replies[source];
      },
    },
    readOfficialPage: async url => pages.get(url),
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (path, fields = {}) => fetch(app.origin + path, {
    method: 'POST', headers: { Origin: app.origin }, body: new URLSearchParams(fields), redirect: 'manual',
  });
  const get = async path => {
    const response = await fetch(app.origin + path);
    assert.equal(response.status, 200);
    return response.text();
  };
  await post('/search/direction', { direction: '容器平台工程' });
  return {
    post, get,
    async run() {
      const response = await post('/search/runs');
      assert.equal(response.status, 303);
      const path = response.headers.get('location');
      for (let count = 0; count < 120; count++) {
        const page = await get(path);
        if (page.includes('重新搜索')) return { page, path };
        await pause(20);
      }
      assert.fail('搜索未结束');
    },
  };
}

test('JS-07-01 一次运行分别显示三个来源，保留已核实 JD 和受限链接', async t => {
  const readable = candidate(official);
  const limited = candidate(maimai, '脉脉平台职位');
  const { run } = await fixture(t, {
    公司社招官网: result([readable]),
    脉脉: result([limited]),
    'BOSS 直聘': result(),
  }, new Map([[official, html(readable)], [maimai, '<title>安全验证</title><p>访问受限，请完成安全验证</p>']]));
  const { page } = await run();
  assert.match(page, /公司社招官网 · 已完成/);
  assert.match(page, /脉脉 · 未完成（访问受限）/);
  assert.match(page, /BOSS 直聘 · 已完成 · 零结果/);
  assert.match(page, /href="\/jobs\/[0-9a-f-]+">平台工程师/);
  assert.match(page, /待核验职位[\s\S]+href="https:\/\/maimai.cn\/jobs\/job_detail\?ejid=abc">脉脉平台职位/);
});

function jobLinks(page, title) {
  return [...page.matchAll(new RegExp(`href="(/jobs/[0-9a-f-]+)">${title}</a>`, 'g'))].map(match => match[1]);
}

test('JS-07-02 后来查到同一招聘编号时合并，已有投递和出处保留，同名职位分别展示', async t => {
  const first = candidate(official);
  const second = candidate(maimai);
  const firstOther = candidate('https://careers.example.org/jobs/PL-102', '容器工程师');
  const secondOther = candidate(boss, '容器工程师');
  const pages = new Map([first, second, firstOther, secondOther].map(job => [job.url, html(job)]));
  const replies = {
    公司社招官网: result([first, firstOther]),
    脉脉: result([second]),
    'BOSS 直聘': result([secondOther]),
  };
  const { run, get, post } = await fixture(t, replies, pages);
  const initial = await run();
  const separate = jobLinks(initial.page, '平台工程师');
  assert.equal(separate.length, 2);
  const appliedPath = separate[1];
  assert.equal((await post(`${appliedPath}/application`)).status, 303);
  assert.equal((await post(`${appliedPath}/application/interviews`, { result: 'passed' })).status, 303);

  // 只有招聘方公开补齐招聘编号后，系统才确认是同一个职位。
  pages.set(official, html(first, { id: 'PL-101' }));
  pages.set(maimai, html(second, { id: 'PL-101' }));
  const update = await run();
  assert.deepEqual(jobLinks(update.page, '平台工程师'), [appliedPath]);
  assert.deepEqual(jobLinks(await get('/'), '平台工程师'), [appliedPath]);
  assert.equal(jobLinks(await get('/'), '容器工程师').length, 2);

  const detail = await get(appliedPath);
  assert.ok(detail.includes(official));
  assert.ok(detail.includes(maimai));
  assert.match(detail, /已投递/);
  assert.match(detail, /一面通过/);
  assert.match(await get(separate[0]), /一面通过/);
});

test('JS-07-03 先显示新增及 JD 更新，核验时间和原链接跟踪参数不改变 JD', async t => {
  const before = candidate(official, '存量岗位');
  const update = candidate('https://careers.example.org/jobs/PL-103', '办公地点变更岗位');
  const added = candidate('https://careers.example.org/jobs/PL-104', '新岗位');
  const replies = { 公司社招官网: result([before, update]), 脉脉: result(), 'BOSS 直聘': result() };
  const pages = new Map([[before.url, html(before)], [update.url, html(update)]]);
  const { run, get, post } = await fixture(t, replies, pages);
  const initial = await run();
  const appliedPath = jobLinks(initial.page, update.title)[0];
  assert.equal((await post(`${appliedPath}/application`)).status, 303);

  const tracked = { ...before, url: `${before.url}?utm_source=second` };
  const changed = { ...update, district: '西湖区' };
  pages.set(tracked.url, html(tracked, { extra: '<p>更新时间：2026-11-07</p>' }));
  pages.set(update.url, html(changed));
  pages.set(added.url, html(added));
  replies.公司社招官网 = result([tracked, changed, added]);
  const second = await run();
  const section = second.page.split('<h2>已核实 JD</h2>')[1].split('<h2>待核验职位</h2>')[0];
  assert.ok(section.indexOf(added.title) < section.indexOf(before.title));
  assert.ok(section.indexOf(update.title) < section.indexOf(before.title));
  assert.match(section, /办公地点变更岗位<\/a> · JD 已更新/);
  assert.match(section, /新岗位<\/a> · 首次发现/);
  assert.doesNotMatch(section, /存量岗位<\/a> · (?:JD 已更新|首次发现)/);

  const home = await get('/');
  assert.equal(jobLinks(home, before.title).length, 1);
  assert.ok(home.indexOf(update.title) < home.indexOf(before.title));
  assert.deepEqual(jobLinks(home, update.title), [appliedPath]);
  const detail = await get(appliedPath);
  assert.match(detail, /办公地点：杭州西湖区/);
  assert.match(detail, /JD 更新于/);
  assert.match(detail, /已投递/);
  const original = await get(jobLinks(home, before.title)[0]);
  assert.ok(original.includes(before.url));
  assert.ok(original.includes(tracked.url));
});

test('官网原文链接只合并可核实的单职位详情，跨源字段分歧保留原文并待确认', async t => {
  const companyJob = candidate(official, '平台工程师', { salaryQuote: '人民币 20k–30k/月' });
  const platformJob = candidate(maimai, '平台研发工程师', { district: '西湖区' });
  const listUrl = 'https://careers.example.org/jobs';
  const listing = candidate(listUrl, '列表内的系统工程师');
  const other = candidate(boss, 'BOSS 系统工程师');
  const original = url => `<p>官网职位：<a href="${url}">查看原文</a></p>`;
  const pages = new Map([
    [official, html(companyJob)],
    [maimai, html(platformJob, { extra: original(`${official}?utm_source=board`) })],
    [listUrl, html(listing)],
    [boss, html(other, { extra: original(listUrl) })],
  ]);
  const { run, get } = await fixture(t, {
    公司社招官网: result([companyJob, listing]), 脉脉: result([platformJob]), 'BOSS 直聘': result([other]),
  }, pages);

  await run();
  const home = await get('/');
  assert.equal(jobLinks(home, listing.title).length, 1);
  assert.equal(jobLinks(home, other.title).length, 1);
  const merged = [...jobLinks(home, companyJob.title), ...jobLinks(home, platformJob.title)];
  assert.equal(merged.length, 1);
  const detail = await get(merged[0]);
  assert.match(detail, /待确认[\s\S]*办公地点/);
  assert.match(detail, /月薪信息有冲突，待确认/);
  assert.match(detail, /办公地点：杭州余杭区/);
  assert.match(detail, /办公地点：杭州西湖区/);
  assert.ok(detail.includes(official) && detail.includes(maimai));
});

test('一个来源执行失败时，另一来源的公开 JD 仍可保存并查看', async t => {
  const readable = candidate(boss, '公开招聘职位');
  const { run, get } = await fixture(t, {
    公司社招官网: result(),
    'BOSS 直聘': result([readable]),
  }, new Map([[boss, html(readable, { extra: '<p><a href="/login">登录</a></p>' })]]));
  const { page } = await run();
  assert.match(page, /搜索 · 部分来源失败/);
  assert.match(page, /公司社招官网 · 已完成 · 零结果/);
  assert.match(page, /脉脉 · 失败/);
  assert.match(page, /BOSS 直聘 · 已完成 · 1 条已核实 JD/);
  assert.match(await get(jobLinks(page, readable.title)[0]), /维护生产 Kubernetes 集群/);
});

test('手动导入和搜索用强证据合并，保留手动原文、旧链接和投递', async t => {
  const first = candidate(official);
  const second = candidate('https://careers.example.org/jobs/PL-202', '容器研发');
  const { run, get, post } = await fixture(t, {
    公司社招官网: result([first, second]), 脉脉: result(), 'BOSS 直聘': result(),
  }, new Map([[first.url, html(first, { id: 'PL-101' })], [second.url, html(second)]]));
  const manual = `平台工程师\n招聘主体：${company}\n招聘编号：PL-101\n职责：手动记录的原文`;
  const noEvidence = `平台工程师\n招聘主体：${company}\n职责：另一条同名职位`;
  const imported = await post('/jobs', { jd: manual });
  const manualPath = imported.headers.get('location');
  assert.equal((await post(`${manualPath}/application`)).status, 303);
  await post('/jobs', { jd: noEvidence });

  const resultPage = await run();
  assert.deepEqual(jobLinks(resultPage.page, first.title), [manualPath]);
  assert.equal(jobLinks(await get('/'), first.title).length, 2);
  const detail = await get(manualPath);
  assert.match(detail, /手动记录的原文/);
  assert.match(detail, /维护生产 Kubernetes 集群/);
  assert.match(detail, /已投递/);

  const discoveredPath = jobLinks(resultPage.page, second.title)[0];
  const pasted = `容器研发\n招聘主体：${company}\nJD 来源：${second.url}\n这段来自使用者的原始粘贴`;
  const afterSearch = await post('/jobs', { jd: pasted });
  assert.equal(afterSearch.headers.get('location'), discoveredPath);
  assert.equal(jobLinks(await get('/'), second.title).length, 1);
  assert.match(await get(discoveredPath), /这段来自使用者的原始粘贴/);
});

test('JS-07-05 官网候选必须能证明发布方，转载或未知发布方不作为同一职位依据', async t => {
  const repost = candidate('https://example.org/jobs/copied', '转载职位');
  const publisher = candidate('https://example.org/jobs/agency', '第三方发布职位');
  const anonymous = candidate('https://example.org/jobs/unknown', '未证明发布方的职位');
  const hosted = candidate('https://developernews.org/jobs/another', '其他域名的同品牌职位');
  const shared = candidate('https://hrcopies.github.io/jobs/PL-101', '共享托管域仿冒职位', { employer: 'HRcopies 科技' });
  const brandedBoard = candidate('https://aggregator.com/jobs/123', '聚合站带招聘方名称');
  const hostedByGoogle = candidate('https://sites.google.com/view/copied/jobs/123', '自助建站伪造的职位', { employer: 'Google' });
  const nestedHost = candidate('https://careers.other.example.org/jobs/123', '任意子域伪造的职位');
  const copiedBrand = candidate(new URL('https://未来.com/jobs/123').href, '中文域名后缀仿冒职位', { employer: '某新未来集团' });
  const genericBrand = candidate(new URL('https://科技.com/jobs/123').href, '通用中文域名仿冒职位', { employer: '星河科技集团' });
  const copiedLogo = candidate(new URL('https://www.未来.com/jobs/123').href, '中文站标后缀仿冒职位', { employer: '某新未来集团' });
  const weakBrands = [hostedByGoogle, nestedHost, copiedBrand, genericBrand, copiedLogo];
  const chinese = candidate(new URL('https://careers.合成科技.com.cn/jobs/PL-102').href, '中文招聘站职位', {
    employer: '杭州合成科技有限公司',
  });
  const tokenFab = candidate('https://www.tokenfab.cn/join/jobs', '仅有站标的官网职位', { employer: null });
  const board = candidate(maimai, '脉脉原帖');
  const responses = {
    公司社招官网: result([repost, publisher, anonymous, hosted, shared, brandedBoard]), 脉脉: result([board]), 'BOSS 直聘': result(),
  };
  const { run, get } = await fixture(t, responses, new Map([
    [repost.url, html(repost, { id: 'PL-101', extra: '<p>本文经原作者授权转载</p>' })],
    [publisher.url, html(publisher, { id: 'PL-101', extra: '<p>发布方：某招聘网</p>' })],
    [anonymous.url, html(anonymous, { id: 'PL-101' }).replace(/<title>.*?<\/title>/, '<title>职位详情</title>')],
    [hosted.url, html(hosted, { id: 'PL-101' })],
    [shared.url, html(shared, { id: 'PL-101' })],
    [brandedBoard.url, html(brandedBoard, { id: 'PL-101', siteLogo: false }).replace('<title>', '<title>Aggregator · ')],
    ...weakBrands.filter(job => job !== copiedLogo).map(job => [job.url, html(job, { id: 'PL-101' })]),
    [copiedLogo.url, html(copiedLogo).replace('<title>某新未来集团 招聘</title>', '<title>未来招聘</title>')
      .replace('<p>招聘主体：某新未来集团</p>', '')],
    [chinese.url, html(chinese, { siteLogo: false }).replace(/<title>.*?<\/title>/,
      '<title>合成科技社会招聘</title><header><a href="/"><img alt="合成科技"></a></header>')],
    [tokenFab.url, html(tokenFab).replace('<title>null 招聘</title>', '<title>TokenFab 招聘</title>')
      .replace('alt="null"', 'alt="TokenFab"').replace('<p>招聘主体：null</p>', '')],
    [board.url, html(board, { id: 'PL-101' })],
  ]));
  const { page } = await run();
  const assertLeads = async (page, jobs) => {
    const [verified, leads] = page.split('<h2>待核验职位</h2>');
    assert.match(verified, /脉脉原帖/);
    const detail = await get(jobLinks(verified, '脉脉原帖')[0]);
    for (const { title, url } of jobs) {
      assert.ok(!verified.includes(title), `${title}不应成为已核实 JD`);
      assert.ok(leads.includes(title), `${title}应保留为待核验`);
      assert.ok(!detail.includes(url), `${title}不应与脉脉原帖合并`);
    }
  };
  await assertLeads(page, [repost, publisher, anonymous, hosted, shared, brandedBoard]);
  responses.公司社招官网 = result(weakBrands);
  await assertLeads((await run()).page, weakBrands);
  responses.公司社招官网 = result([chinese, tokenFab]);
  const trusted = (await run()).page.split('<h2>待核验职位</h2>')[0];
  assert.match(trusted, /中文招聘站职位/);
  assert.match(trusted, /仅有站标的官网职位/);
});

test('JS-07-06 本机读到的 HTTP 200 验证墙也标为来源受限，普通登录链接与公开摘要照常展示', async t => {
  const blocked = candidate(official, '官网受限职位', { duties: [], requirements: [] });
  const readable = candidate('https://careers.example.org/jobs/other', '公开职位');
  const summary = candidate(boss, '只有摘要的职位', { duties: [], requirements: [] });
  const challenge = candidate(maimai, '英文验证墙职位', { duties: [], requirements: [] });
  const replies = {
    公司社招官网: result([blocked, readable], { unreadable: [blocked.url] }),
    脉脉: result([challenge], { unreadable: [challenge.url] }), 'BOSS 直聘': result([summary]),
  };
  const pages = new Map([
    [blocked.url, '<title>官网职位</title><main><p>请先登录，查看职位详情</p></main>'],
    [readable.url, html(readable, { extra: '<p><a href="/login">登录</a></p>' })],
    [summary.url, '<title>只有摘要的职位</title><main><p>仅展示普通摘要</p></main><footer>登录后查看投递进度</footer>'],
    [challenge.url, '<title>Human verification</title><main><p>Please verify that you are human</p></main>'],
  ]);
  const { run } = await fixture(t, replies, pages);
  const { page } = await run();
  assert.match(page, /公司社招官网 · 未完成（访问受限）/);
  assert.match(page, /脉脉 · 未完成（访问受限）/);
  assert.match(page, /BOSS 直聘 · 已完成/);
  const [verified, leads] = page.split('<h2>待核验职位</h2>');
  assert.match(verified, /公开职位/);
  assert.match(leads, /官网受限职位[\s\S]*只有摘要的职位/);

  pages.set(challenge.url, '<title>Just a moment...</title><main><p>Enable JavaScript and cookies to continue</p></main>');
  pages.set(summary.url, '<title>Job details</title><main><p>Please, sign in to view the full job description.</p></main>');
  const retry = await run();
  assert.match(retry.page, /脉脉 · 未完成（访问受限）/);
  assert.match(retry.page, /BOSS 直聘 · 未完成（访问受限）/);
});

test('仅另一来源读取到同一 JD 时刷新简历匹配，不标为 JD 更新', async t => {
  const companyJob = candidate(official);
  const boardJob = candidate(maimai);
  const pages = new Map([[official, html(companyJob, { id: 'PL-101' })], [maimai, html(boardJob, { id: 'PL-101' })]]);
  const replies = { 公司社招官网: result([companyJob]), 脉脉: result([boardJob]), 'BOSS 直聘': result() };
  const { run, get, post } = await fixture(t, replies, pages, ({ jobs, resume }) => ({
    value: { results: jobs.map(({ id, jd }) => ({
      id, decision: 'matched', evidence: [
        { kind: 'duty', jdQuote: jd.split('岗位职责\n')[1].split('\n')[0], resumeQuote: resume },
        { kind: 'requirement', jdQuote: companyJob.requirements[0], resumeQuote: resume },
      ],
    })) },
  }));
  async function saveResume(technical) {
    assert.equal((await post('/settings/resume', { resume: '姓名：合成用户\n' + technical })).status, 303);
    const revision = (await get('/settings/resume')).match(/name="revision" value="([^"]+)"/)[1];
    assert.equal((await post('/settings/resume/technical', { revision, technical })).status, 303);
    assert.equal((await post('/search/direction', { direction: '容器平台工程' })).status, 303);
  }
  await saveResume('旧版容器平台经历');
  const first = await run();
  const [path] = jobLinks(first.page, companyJob.title);
  assert.equal((await post(`${path}/application`)).status, 303);
  assert.match(await get(path), /符合筛选条件/);
  await saveResume('新版容器平台经历');
  replies.公司社招官网 = result();
  const rerun = await run();
  assert.deepEqual(jobLinks(rerun.page, boardJob.title), [path]);
  const detail = await get(path);
  assert.match(detail, /符合筛选条件[\s\S]*<q>新版容器平台经历<\/q>/);
  assert.doesNotMatch(detail, /JD 更新于|简历已更新，匹配待重新确认|旧版容器平台经历/);
  assert.match(detail, /已投递/);
  assert.ok(detail.includes(official) && detail.includes(maimai));

  // 已知另一版本的正文在下一次没有变化时，其新引文也不能绑定给当前展示版本。
  const changedJob = candidate(official, companyJob.title, { duties: ['迁移线上微服务到 Kubernetes'] });
  replies.公司社招官网 = result([changedJob]);
  pages.set(official, html(changedJob, { id: 'PL-101' }));
  replies.脉脉 = result();
  await run();
  assert.match(await get(path), /迁移线上微服务到 Kubernetes/);
  await saveResume('第三版容器平台经历');
  replies.公司社招官网 = result();
  replies.脉脉 = result([boardJob]);
  await run();
  const differentBody = await get(path);
  assert.match(differentBody, /简历已更新，匹配待重新确认/);
  assert.doesNotMatch(differentBody, /<q>第三版容器平台经历<\/q>/);
});

test('JS-07-07 不同招聘方的同号公开职位分别保留，同一招聘方可以跨源合并', async t => {
  const first = candidate(official, '甲方招聘的职位');
  const same = candidate(maimai, first.title);
  const distinct = candidate(boss, '乙方招聘的职位', { employer: '乙科技' });
  const unnamed = candidate('https://www.zhipin.com/job_detail/unnamed.html', '招聘主体未知的职位');
  const contract = '<p>签约主体：合成外包公司</p>';
  const citation = `<p>官网职位：<a href="${official}?utm_source=board">查看原文</a></p>`;
  const pageFor = (job, extra = '') => html(job, { id: '123', extra: contract + extra });
  const { run, get, post } = await fixture(t, {
    公司社招官网: result([first]), 脉脉: result([same]), 'BOSS 直聘': result([distinct, unnamed]),
  }, new Map([
    [first.url, pageFor(first)], [same.url, pageFor(same)], [distinct.url, pageFor(distinct, citation)],
    [unnamed.url, pageFor(unnamed, citation).replace(`<p>招聘主体：${unnamed.employer}</p>`, '')],
  ]));
  const { page } = await run();
  const firstPaths = jobLinks(page, first.title);
  const otherPaths = jobLinks(page, distinct.title);
  const unnamedPaths = jobLinks(page, unnamed.title);
  assert.equal(firstPaths.length, 1);
  assert.equal(otherPaths.length, 1);
  assert.equal(unnamedPaths.length, 1);
  assert.equal(new Set([...firstPaths, ...otherPaths, ...unnamedPaths]).size, 3);
  const detail = await get(firstPaths[0]);
  assert.ok(detail.includes(first.url) && detail.includes(same.url));
  assert.ok(!detail.includes(distinct.url) && !detail.includes(unnamed.url));

  const manual = await post('/jobs', {
    jd: `独立手动职位\n招聘主体：乙科技\nJD 来源：${official}\n职责：使用者手动保存的正文`,
  });
  assert.equal(manual.status, 303);
  assert.notEqual(manual.headers.get('location'), firstPaths[0]);
});
