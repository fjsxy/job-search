import { randomUUID } from 'node:crypto';
import { screenHardConditions } from './job-criteria.mjs';
import { combineScreening } from './screening.mjs';
import { manualIdentity, observationKeys, restoredObservationKeys } from './job-sources.mjs';

function comparableJob(jd) {
  // 页面时间、跟踪链接和招聘编号只描述出处；职责、要求及职位字段才决定 JD 是否有变化。
  return jd.split('\n').map(line => line.normalize('NFKC').replace(/\s+/gu, ' ').trim())
    .filter(line => line && !/^(?:更新时间|发布时间|发布于|招聘编号|(?:职位|岗位)编号|公司官网|官网职位|官网原文|官方职位链接)\s*:/u.test(line))
    .join('\n');
}

function reconcileScreening(display, rows) {
  if (rows.length < 2) return {};
  const observations = rows.map(row => JSON.parse(row.details));
  const original = observations.find(job => observationKeys(job).source === observationKeys(display).source);
  const match = original?.screening ?? display.screening;
  if (!match) return {};
  // 汇总每个已核实来源的硬条件事实。匹配引文仍对应当前展示的那份 JD。
  const facts = { employers: [], groups: [], locations: [], salaries: [] };
  for (const job of observations) {
    const sourceFacts = job.facts ?? {
      employers: [job.employer], groups: [], locations: [job.cityEvidence, job.districtEvidence, job.city],
      salaries: [job.salaryQuote],
    };
    for (const name of Object.keys(facts)) facts[name].push(...sourceFacts[name].filter(Boolean));
  }
  const hard = screenHardConditions({ ...display, facts, observedCities: observations.map(job => job.city) });
  const conflicts = hard.pending.flatMap(message => {
    const label = /^(招聘主体|Base|办公地点|月薪)\s*信息有冲突/u.exec(message)?.[1];
    return label ? [label] : [];
  });
  const screening = combineScreening(hard,
    match.matchStatus === 'skipped' && !hard.excluded.length ? { matchStatus: 'pending' } : match);
  return { screening, conflicts };
}

function migrateObservationKeys(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version < 1) {
      // 关键：只重建归并索引，原观察、出处和投递原位保留。旧索引已被清空的观察也参与恢复。
      const observations = db.prepare('SELECT rowid, jd, details FROM job_observations').all();
      const update = db.prepare(`
        UPDATE job_observations SET publisher_key = ?, owned_url_key = ?, cited_url_key = ? WHERE rowid = ?
      `);
      for (const { rowid, jd, details } of observations) {
        const { publisher, owned, cited } = restoredObservationKeys(JSON.parse(details).source, jd);
        update.run(publisher, owned, cited, rowid);
      }
      db.exec('PRAGMA user_version = 1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createDiscoveryStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_observations (
      job_id TEXT NOT NULL REFERENCES jobs (id),
      source_key TEXT NOT NULL,
      publisher_key TEXT,
      owned_url_key TEXT,
      cited_url_key TEXT,
      jd TEXT NOT NULL,
      details TEXT NOT NULL,
      urls TEXT NOT NULL,
      PRIMARY KEY (job_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS job_observations_source ON job_observations (source_key);
    CREATE INDEX IF NOT EXISTS job_observations_publisher ON job_observations (publisher_key);
    CREATE INDEX IF NOT EXISTS job_observations_owned ON job_observations (owned_url_key);
    CREATE INDEX IF NOT EXISTS job_observations_cited ON job_observations (cited_url_key);
    CREATE TABLE IF NOT EXISTS manual_jds (
      job_id TEXT NOT NULL REFERENCES jobs (id),
      jd TEXT NOT NULL,
      publisher_key TEXT,
      owned_url_key TEXT
    );
    CREATE INDEX IF NOT EXISTS manual_jds_job ON manual_jds (job_id);
    CREATE INDEX IF NOT EXISTS manual_jds_publisher ON manual_jds (publisher_key);
    CREATE INDEX IF NOT EXISTS manual_jds_owned ON manual_jds (owned_url_key);
    CREATE TABLE IF NOT EXISTS job_aliases (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs (id)
    );
  `);

  migrateObservationKeys(db);
  // 手动原文仍可重新提取招聘主体；之前因身份冲突而禁用的索引继续禁用。
  const staleManual = db.prepare(`
    SELECT rowid, jd FROM manual_jds WHERE json_array_length(publisher_key) = 2
      OR (owned_url_key IS NOT NULL AND owned_url_key NOT LIKE '["official-position",%')
  `).all();
  const reindexManual = db.prepare('UPDATE manual_jds SET publisher_key = ?, owned_url_key = ? WHERE rowid = ?');
  for (const { rowid, jd } of staleManual) {
    const { publisher, owned } = manualIdentity(jd);
    reindexManual.run(publisher, owned, rowid);
  }

  const saveObservation = db.prepare(`
    INSERT INTO job_observations (job_id, source_key, publisher_key, owned_url_key, cited_url_key, jd, details, urls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, source_key) DO UPDATE SET
      publisher_key = excluded.publisher_key, owned_url_key = excluded.owned_url_key,
      cited_url_key = excluded.cited_url_key, jd = excluded.jd, details = excluded.details, urls = excluded.urls
  `);
  const selectObservations = db.prepare('SELECT * FROM job_observations WHERE job_id = ? ORDER BY rowid');
  const selectObservation = db.prepare('SELECT * FROM job_observations WHERE job_id = ? AND source_key = ?');
  const relatedJobs = db.prepare(`
    WITH related(id) AS (
      SELECT job_id FROM job_observations
      WHERE source_key = ? OR publisher_key = ? OR owned_url_key IN (?, ?) OR cited_url_key = ?
      UNION
      SELECT job_id FROM manual_jds WHERE publisher_key = ? OR owned_url_key = ?
    )
    SELECT jobs.id, applications.id AS applicationId
    FROM related JOIN jobs ON jobs.id = related.id
    LEFT JOIN applications ON applications.job_id = jobs.id
    ORDER BY applications.id IS NOT NULL DESC,
      EXISTS (SELECT 1 FROM manual_jds WHERE job_id = jobs.id) DESC, jobs.rowid
  `);
  const insertManual = db.prepare('INSERT INTO manual_jds (job_id, jd, publisher_key, owned_url_key) VALUES (?, ?, ?, ?)');
  const selectManual = db.prepare('SELECT jd FROM manual_jds WHERE job_id = ? ORDER BY rowid');
  const matchesForManual = db.prepare(`
    SELECT job_id AS id FROM job_observations WHERE publisher_key = ? OR owned_url_key = ?
    UNION
    SELECT job_id AS id FROM manual_jds WHERE publisher_key = ?
  `);
  const moveManual = db.prepare('UPDATE manual_jds SET job_id = ? WHERE job_id = ?');
  const insertJob = db.prepare('INSERT INTO jobs (id, jd) VALUES (?, ?)');
  const insertDiscovery = db.prepare('INSERT INTO discovered_jobs (job_id, source_key, details) VALUES (?, ?, ?)');
  const selectDiscovery = db.prepare(`
    SELECT jobs.jd, discovered_jobs.details FROM jobs JOIN discovered_jobs ON discovered_jobs.job_id = jobs.id
    WHERE jobs.id = ?
  `);
  const updateJob = db.prepare('UPDATE jobs SET jd = ? WHERE id = ?');
  const updateDiscovery = db.prepare('UPDATE discovered_jobs SET details = ? WHERE job_id = ?');
  const addAlias = db.prepare('INSERT INTO job_aliases (id, job_id) VALUES (?, ?)');
  const moveAliases = db.prepare('UPDATE job_aliases SET job_id = ? WHERE job_id = ?');
  const removeObservations = db.prepare('DELETE FROM job_observations WHERE job_id = ?');
  const removeDiscovery = db.prepare('DELETE FROM discovered_jobs WHERE job_id = ?');
  const removeJob = db.prepare('DELETE FROM jobs WHERE id = ?');

  // 旧版本只存一个官网出处。原位补齐索引以继续保留原 ID、JD 和投递。
  const legacy = db.prepare(`
    SELECT discovered_jobs.job_id, discovered_jobs.details, jobs.jd FROM discovered_jobs
    JOIN jobs ON jobs.id = discovered_jobs.job_id
    WHERE NOT EXISTS (SELECT 1 FROM job_observations WHERE job_id = discovered_jobs.job_id)
  `).all();
  for (const { job_id, details, jd } of legacy) {
    const record = JSON.parse(details);
    const key = restoredObservationKeys(record.source, jd);
    saveObservation.run(job_id, key.source, key.publisher, key.owned, key.cited, jd, details, JSON.stringify([record.source.url]));
  }

  const legacyManual = db.prepare(`
    SELECT id, jd FROM jobs
    WHERE NOT EXISTS (SELECT 1 FROM discovered_jobs WHERE job_id = jobs.id)
      AND NOT EXISTS (SELECT 1 FROM manual_jds WHERE job_id = jobs.id)
  `).all();
  for (const { id, jd } of legacyManual) {
    const { publisher, owned } = manualIdentity(jd);
    insertManual.run(id, jd, publisher, owned);
  }

  function writeObservation(id, { source_key, publisher_key, owned_url_key, cited_url_key, jd, details, urls }) {
    const previous = selectObservation.get(id, source_key);
    const allUrls = [...new Set([...JSON.parse(previous?.urls ?? '[]'), ...JSON.parse(urls)])];
    saveObservation.run(id, source_key, publisher_key, owned_url_key, cited_url_key, jd, details, JSON.stringify(allUrls));
  }

  function mergeJobs(keeper, duplicate) {
    for (const observation of selectObservations.all(duplicate.id)) {
      writeObservation(keeper.id, observation);
    }
    if (duplicate.applicationId) {
      // 两条旧职位都已投递时，保留原轮次 ID 和顺序，旧页面地址继续解析到合并后的职位。
      db.prepare(`
        UPDATE interview_rounds SET application_id = ?, round_number = round_number + (
          SELECT COALESCE(MAX(round_number), 0) FROM interview_rounds WHERE application_id = ?
        ) WHERE application_id = ?
      `).run(keeper.applicationId, keeper.applicationId, duplicate.applicationId);
      db.prepare('DELETE FROM applications WHERE id = ?').run(duplicate.applicationId);
    }
    moveManual.run(keeper.id, duplicate.id);
    moveAliases.run(keeper.id, duplicate.id);
    addAlias.run(duplicate.id, keeper.id);
    removeObservations.run(duplicate.id);
    removeDiscovery.run(duplicate.id);
    removeJob.run(duplicate.id);
  }

  return {
    addManual(jd) {
      const { publisher, owned } = manualIdentity(jd);
      // 招聘主体和编号可以匹配手动记录，官网链接仍须有唯一的已核实原文。
      db.exec('BEGIN IMMEDIATE');
      try {
        const matches = matchesForManual.all(publisher, owned, publisher);
        const existing = matches.length === 1 && matches[0].id;
        const id = existing || randomUUID();
        if (!existing) insertJob.run(id, jd);
        insertManual.run(id, jd, matches.length > 1 ? null : publisher, matches.length > 1 ? null : owned);
        db.exec('COMMIT');
        return id;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    readSources(id) {
      const observations = selectObservations.all(id).map(observation => ({
        ...JSON.parse(observation.details), jd: observation.jd, urls: JSON.parse(observation.urls),
      }));
      const sources = observations.flatMap(({ source, urls }) => urls.map(url => ({ ...source, url })));
      return {
        sources, manualJds: selectManual.all(id).map(({ jd }) => jd), sourceJds: observations.map(({ source, jd }) => ({ source, jd })),
      };
    },
    save({ jd, ...details }, { runId, observedAt }) {
      const key = observationKeys(details);
      const related = relatedJobs.all(key.source, key.publisher, key.cited, key.owned, key.owned, key.publisher, key.owned);
      const [keeper, ...duplicates] = related;
      const id = keeper?.id ?? randomUUID();
      const previousDisplay = keeper && selectDiscovery.get(id);
      const previousDetails = related.flatMap(job => {
        const record = selectDiscovery.get(job.id);
        return record ? [JSON.parse(record.details)] : [];
      });
      if (keeper) {
        for (const duplicate of duplicates) mergeJobs(keeper, duplicate);
      }
      const previousSource = selectObservation.get(id, key.source);
      const prior = previousDisplay && JSON.parse(previousDisplay.details);
      const changed = Boolean(prior && prior.firstRunId !== runId
        && comparableJob((previousSource ?? previousDisplay).jd) !== comparableJob(jd));
      const sameSource = prior && observationKeys(prior).source === key.source;
      // 只有同一份 JD 可用另一来源刷新匹配，展示正文与引文一起切换。
      const incomingMatch = details.screening;
      const priorMatch = prior?.screening;
      const refreshedMatch = prior && incomingMatch?.resumeRevision
        && ['matched', 'unmatched'].includes(incomingMatch.matchStatus)
        && (incomingMatch.resumeRevision !== priorMatch?.resumeRevision || priorMatch?.matchStatus === 'pending')
        && comparableJob(previousDisplay.jd) === comparableJob(jd);
      // 每个来源独立比对自己的上一份 JD，避免两个版本来回覆盖并重复标为更新。
      const display = !prior || sameSource || changed || refreshedMatch ? details : prior;
      const [oldest] = previousDetails
        .map(details => ({ at: details.firstDiscoveredAt ?? details.source.verifiedAt, runId: details.firstRunId }))
        .filter(item => item.at).sort((left, right) => left.at.localeCompare(right.at));
      const [latestChange] = previousDetails.filter(job => job.changedAt)
        .sort((left, right) => right.changedAt.localeCompare(left.changedAt));
      const activity = {
        firstDiscoveredAt: oldest?.at ?? observedAt,
        firstRunId: oldest ? oldest.runId : runId,
        changedAt: changed ? observedAt : latestChange?.changedAt,
        changedRunId: changed ? runId : latestChange?.changedRunId,
      };
      if (keeper) {
        if (display === details) updateJob.run(jd, id);
      } else {
        insertJob.run(id, jd);
      }
      writeObservation(id, {
        source_key: key.source, publisher_key: key.publisher, owned_url_key: key.owned, cited_url_key: key.cited,
        jd, details: JSON.stringify(details), urls: JSON.stringify([details.source.url]),
      });
      const screening = reconcileScreening(display, selectObservations.all(id));
      const serialized = JSON.stringify({ ...display, ...activity, ...screening });
      if (prior) updateDiscovery.run(serialized, id);
      // 手动职位首次核实时新建发现记录，保留原 ID 和手动原文。
      else insertDiscovery.run(id, id, serialized);
      return id;
    },
  };
}
