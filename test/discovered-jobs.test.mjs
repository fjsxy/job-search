import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { observationKeys } from '../src/job-sources.mjs';
import { createJobStore, openDatabase } from '../src/store.mjs';

const recruiter = 'Example 合成科技';
const contractor = '合成签约雇主';
const first = { runId: '旧搜索', observedAt: '2026-11-01T00:00:00.000Z' };
const next = { runId: '新搜索', observedAt: '2026-11-02T00:00:00.000Z' };
const officialUrl = id => `https://careers.example.org/jobs/${id}`;

function verifiedRecord(id, source, recruiters = [recruiter]) {
  const title = `平台工程师 ${id}`;
  const jd = [
    title, ...recruiters.map(name => `招聘主体：${name}`), `签约主体：${contractor}`,
    '官网职位：查看原文', '岗位职责', '维护生产 Kubernetes 集群', '任职要求', '掌握 Go 与 Linux',
  ].join('\n');
  return {
    jd, title, employer: contractor,
    source: { locator: title, publisherEvidence: `${recruiters[0]} 招聘`, verifiedAt: first.observedAt, ...source },
  };
}

function seedLegacy(db, id, { jd, ...details }, [publisher, owned, cited]) {
  // 保存实际旧表使用的索引格式。观察详情和原文独立于索引，已清空索引的库也仍有证据。
  const { source } = observationKeys(details);
  const serialized = JSON.stringify({ ...details, firstRunId: first.runId });
  db.prepare('INSERT INTO jobs VALUES (?, ?)').run(id, jd);
  db.prepare('INSERT INTO discovered_jobs VALUES (?, ?, ?)').run(id, source, serialized);
  db.prepare('INSERT INTO job_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, source, publisher, owned, cited, jd, serialized, JSON.stringify([details.source.url]));
  db.prepare('INSERT INTO applications VALUES (?, ?)').run(`投递-${id}`, id);
}

test('JS-07-02 升级旧归并索引，保留已投递职位、原文和来源', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'job-search-upgrade-'));
  let db = openDatabase(dataDir);
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  createJobStore(db);
  db.exec('PRAGMA user_version = 0');
  const variants = [
    { id: 'released', cited: JSON.stringify([contractor, officialUrl('released')]) },
    { id: 'cleared', cited: null },
    { id: 'intermediate', cited: officialUrl('intermediate'), source: { publisherRecruiter: recruiter } },
    { id: 'contract-only', cited: JSON.stringify([contractor, officialUrl('contract-only')]), recruiters: [] },
    { id: 'conflicting', cited: JSON.stringify([contractor, officialUrl('conflicting')]), recruiters: [recruiter, '另一招聘主体'] },
  ].map(({ id, cited, source, recruiters }) => {
    const platform = verifiedRecord(id, {
      kind: 'maimai', url: `https://maimai.cn/jobs/job_detail?ejid=${id}`,
      citedOfficialUrl: officialUrl(id) + '?utm_source=board', ...source,
    }, recruiters);
    seedLegacy(db, id, platform, [null, null, cited]);
    return { id, platform, merge: recruiters === undefined };
  });

  const mirror = verifiedRecord('mirror', {
    kind: 'official', url: 'https://sites.google.com/view/copied/jobs/123', officialPublisherDomain: 'google.com',
    publisherRecruiter: 'Google', publisherJobKey: '123', officialPosition: true,
  }, ['Google']);
  seedLegacy(db, 'mirror', mirror, [JSON.stringify(['recruiter', 'google', '123']), mirror.source.url, null]);
  const legit = verifiedRecord('legit', {
    kind: 'official', url: officialUrl('legit'), officialPublisherDomain: 'example.org',
    publisherRecruiter: recruiter, officialPosition: true,
  });
  seedLegacy(db, 'legit', legit, [null, legit.source.url, null]);
  const unchecked = verifiedRecord('unchecked', { kind: 'official', url: officialUrl('unchecked'), officialPosition: true });
  seedLegacy(db, 'unchecked', unchecked, [null, JSON.stringify([recruiter, unchecked.source.url]), null]);

  db.close();
  db = openDatabase(dataDir);
  createJobStore(db);
  const observations = db.prepare('SELECT * FROM job_observations ORDER BY rowid').all();
  const mirrorKeys = observations.find(({ job_id }) => job_id === 'mirror');
  assert.equal(mirrorKeys.publisher_key, null);
  assert.equal(mirrorKeys.owned_url_key, null);
  assert.equal(observations.length, variants.length + 3);

  // 重启不重复迁移，之前已清空的索引仍能归并到原来的投递。
  db.close();
  db = openDatabase(dataDir);
  const store = createJobStore(db);
  assert.deepEqual(db.prepare('SELECT * FROM job_observations ORDER BY rowid').all(), observations);
  for (const { id, platform, merge } of variants) {
    const official = verifiedRecord(id, {
      kind: 'official', url: officialUrl(id), officialPublisherDomain: 'example.org',
      publisherRecruiter: recruiter, officialPosition: true,
    });
    const found = store.saveDiscoveredJob(official, next);
    assert.equal(found === id, merge, id);
    assert.equal(store.getApplication(id).id, `投递-${id}`);
    assert.equal(store.getApplication(found)?.id, merge ? `投递-${id}` : undefined);
    assert.ok(store.getJob(id).sourceJds.some(({ jd, source }) => jd === platform.jd && source.url === platform.source.url));
  }

  const boss = verifiedRecord('boss', {
    kind: 'boss', url: 'https://www.zhipin.com/job_detail/123.html', publisherRecruiter: 'Google', publisherJobKey: '123',
  }, ['Google']);
  assert.notEqual(store.saveDiscoveredJob(boss, next), 'mirror');
  assert.equal(store.getApplication('mirror').id, '投递-mirror');
  assert.equal(store.getJob('mirror').sourceJds[0].jd, mirror.jd);

  const manual = url => `手动导入\n招聘主体：${recruiter}\nJD 来源：${url}\n职责\n维护生产集群`;
  assert.equal(store.addManualJob(manual(legit.source.url)), 'legit');
  assert.notEqual(store.addManualJob(manual(unchecked.source.url)), 'unchecked');
  assert.equal(store.getApplication('legit').id, '投递-legit');
  assert.equal(store.getApplication('unchecked').id, '投递-unchecked');
});
