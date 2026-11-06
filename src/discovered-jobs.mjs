import { randomUUID } from 'node:crypto';
import { observationKeys } from './job-sources.mjs';

function comparableJob(jd) {
  // 页面时间、跟踪链接和招聘编号只描述出处；职责、要求及职位字段才决定 JD 是否有变化。
  return jd.split('\n').map(line => line.normalize('NFKC').replace(/\s+/gu, ' ').trim())
    .filter(line => line && !/^(?:更新时间|发布时间|发布于|招聘编号|(?:职位|岗位)编号|公司官网|官网职位|官网原文|官方职位链接)\s*:/u.test(line))
    .join('\n');
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
    CREATE TABLE IF NOT EXISTS job_aliases (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs (id)
    );
  `);

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
    SELECT jobs.id, applications.id AS applicationId
    FROM jobs JOIN job_observations AS observation ON observation.job_id = jobs.id
    LEFT JOIN applications ON applications.job_id = jobs.id
    WHERE observation.source_key = ? OR observation.publisher_key = ?
      OR observation.owned_url_key IN (?, ?) OR observation.cited_url_key = ?
    GROUP BY jobs.id
    ORDER BY applications.id IS NOT NULL DESC, jobs.rowid
  `);
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
    const key = observationKeys(record);
    saveObservation.run(job_id, key.source, key.publisher, key.owned, key.cited, jd, details, JSON.stringify([record.source.url]));
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
    moveAliases.run(keeper.id, duplicate.id);
    addAlias.run(duplicate.id, keeper.id);
    removeObservations.run(duplicate.id);
    removeDiscovery.run(duplicate.id);
    removeJob.run(duplicate.id);
  }

  return {
    readSources(id) {
      const observations = selectObservations.all(id).map(observation => ({
        ...JSON.parse(observation.details), jd: observation.jd, urls: JSON.parse(observation.urls),
      }));
      const sources = observations.flatMap(({ source, urls }) => urls.map(url => ({ ...source, url })));
      const fields = { employer: '招聘主体', city: 'Base', district: '办公地点', salaryQuote: '月薪' };
      const conflicts = Object.entries(fields).flatMap(([key, label]) => {
        const values = new Set(observations.map(job => job[key]?.normalize('NFKC').replace(/\s+/gu, '')).filter(Boolean));
        return values.size > 1 ? [label] : [];
      });
      return {
        sources, conflicts, sourceJds: observations.map(({ source, jd }) => ({ source, jd })),
      };
    },
    save({ jd, ...details }, { runId, observedAt }) {
      const key = observationKeys(details);
      const related = relatedJobs.all(key.source, key.publisher, key.cited, key.owned, key.owned);
      const [keeper, ...duplicates] = related;
      const id = keeper?.id ?? randomUUID();
      const previousDisplay = keeper && selectDiscovery.get(id);
      const previousDetails = related.map(job => JSON.parse(selectDiscovery.get(job.id).details));
      if (keeper) {
        for (const duplicate of duplicates) mergeJobs(keeper, duplicate);
      }
      const previousSource = selectObservation.get(id, key.source);
      const prior = previousDisplay && JSON.parse(previousDisplay.details);
      const changed = Boolean(prior && prior.firstRunId !== runId
        && comparableJob((previousSource ?? previousDisplay).jd) !== comparableJob(jd));
      const sameSource = prior && observationKeys(prior).source === key.source;
      // 每个来源独立比对自己的上一份 JD，避免两个版本来回覆盖并重复标为更新。
      const display = !prior || sameSource || changed ? details : prior;
      const [oldest] = previousDetails
        .map(details => ({ at: details.firstDiscoveredAt ?? details.source.verifiedAt, runId: details.firstRunId }))
        .filter(item => item.at).sort((left, right) => left.at.localeCompare(right.at));
      const activity = {
        firstDiscoveredAt: oldest?.at ?? observedAt,
        firstRunId: oldest ? oldest.runId : runId,
        changedAt: changed ? observedAt : prior?.changedAt,
        changedRunId: changed ? runId : prior?.changedRunId,
      };
      const serialized = JSON.stringify({ ...display, ...activity });
      if (keeper) {
        if (display === details) updateJob.run(jd, id);
        updateDiscovery.run(serialized, id);
      } else {
        insertJob.run(id, jd);
        // 保留旧表的原始约束，实际查找使用 job_observations 的同一性键。
        insertDiscovery.run(id, id, serialized);
      }
      writeObservation(id, {
        source_key: key.source, publisher_key: key.publisher, owned_url_key: key.owned, cited_url_key: key.cited,
        jd, details: JSON.stringify(details), urls: JSON.stringify([details.source.url]),
      });
      return id;
    },
  };
}
