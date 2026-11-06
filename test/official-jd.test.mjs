import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOfficialVerifier } from '../src/official-jd.mjs';

test('JS-07-08 大量同名标题共享容器时仍按独立招聘编号核实，正文不串到另一岗位', async () => {
  const url = 'https://careers.example.com.cn/jobs';
  const title = '平台工程师';
  const candidate = {
    url, title, jobKey: 'PL-101',
    duties: ['维护生产 Kubernetes 集群'], requirements: ['掌握 Go 与 Linux'],
  };
  const html = `<title>Example 合成公司招聘</title><header><a href="/"><img alt="Example 合成公司"></a></header><main>
    <article><h1>${title}</h1><p>招聘主体：Example 合成公司</p><p>招聘编号：PL-101</p>
    <h2>岗位职责</h2><p>维护生产 Kubernetes 集群</p><h2>任职要求</h2><p>掌握 Go 与 Linux</p></article>
    <article><h1>${title}</h1><p>招聘主体：Example 合成公司</p><p>招聘编号：PL-102</p>
    <h2>岗位职责</h2><p>负责另一职位的排班</p><h2>任职要求</h2><p>掌握客服排班系统</p></article>
    <section>${`<h1>${title}</h1>`.repeat(1600)}</section></main>`;
  const evidence = [{ action: { type: 'open_page' }, results: [{ url, snippet: 'Total lines: 1605' }] }];
  const verify = createOfficialVerifier(async () => html);
  const before = performance.now();
  const result = await verify(candidate, evidence, undefined, 'official');
  const elapsed = performance.now() - before;
  assert.ok(elapsed < 1000, `重复展开相同容器，核验耗时 ${Math.round(elapsed)} ms`);
  assert.match(result?.verified?.jd, /招聘编号：PL-101/);
  assert.doesNotMatch(result.verified.jd, /客服排班系统|另一职位/);
  assert.equal(result.verified.source.officialPosition, false);
  assert.equal((await verify({ ...candidate, jobKey: 'PL-102' }, evidence, undefined, 'official')).verified, undefined);
});

test('JS-07-08 过深的网页及时降级为待核验，避免在构建 DOM 和展开标题时阻塞', async () => {
  const url = 'https://careers.example.org/jobs/PL-101';
  const candidate = {
    url, title: '平台工程师',
    duties: ['维护生产 Kubernetes 集群'], requirements: ['掌握 Go 与 Linux'],
  };
  const html = '<title>Example 招聘</title>' + '<h1><div>'.repeat(6400)
    + candidate.title + '</div></h1>'.repeat(6400);
  const evidence = [{ action: { type: 'open_page' }, results: [{ url, snippet: 'Total lines: 6400' }] }];
  const verify = createOfficialVerifier(async () => html);
  const before = performance.now();
  const result = await verify(candidate, evidence, undefined, 'official');
  const elapsed = performance.now() - before;
  assert.ok(elapsed < 1000, `处理病态 HTML 耗时 ${Math.round(elapsed)} ms`);
  assert.equal(result?.lead?.source.url, url);
  assert.equal(result?.verified, undefined);
});
