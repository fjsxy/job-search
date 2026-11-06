import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dataDir) {
  // 私有目录同时包含 SQLite 主文件和恢复事务所需的临时文件。
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'job-search.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createJobStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      jd TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discovered_jobs (
      job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs (id),
      source_key TEXT NOT NULL UNIQUE,
      details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs (id)
    );
  `);

  const insertJob = db.prepare('INSERT INTO jobs (id, jd) VALUES (?, ?)');
  const selectJobs = db.prepare(`
    SELECT jobs.id, jobs.jd, discovered_jobs.details, applications.id AS applicationId
    FROM jobs
    LEFT JOIN discovered_jobs ON discovered_jobs.job_id = jobs.id
    LEFT JOIN applications ON applications.job_id = jobs.id
    ORDER BY jobs.rowid DESC
  `);
  const selectJob = db.prepare(`
    SELECT jobs.id, jobs.jd, discovered_jobs.details
    FROM jobs LEFT JOIN discovered_jobs ON discovered_jobs.job_id = jobs.id WHERE jobs.id = ?
  `);
  const getDiscoveredJob = db.prepare('SELECT job_id AS id FROM discovered_jobs WHERE source_key = ?');
  const insertDiscovery = db.prepare('INSERT INTO discovered_jobs (job_id, source_key, details) VALUES (?, ?, ?)');
  const updateDiscovery = db.prepare('UPDATE discovered_jobs SET details = ? WHERE job_id = ?');
  const updateJob = db.prepare('UPDATE jobs SET jd = ? WHERE id = ?');
  const insertApplication = db.prepare(`
    INSERT INTO applications (id, job_id) VALUES (?, ?)
    ON CONFLICT (job_id) DO NOTHING
  `);
  const selectApplication = db.prepare('SELECT id, job_id AS jobId FROM applications WHERE job_id = ?');

  return {
    addManualJob(jd) {
      // 仅将空白判断用于校验，写入时保存完整的 JD。
      const id = randomUUID();
      insertJob.run(id, jd);
      return id;
    },
    listJobs: () => selectJobs.all().map(({ id, jd, details, applicationId }) =>
      ({ ...JSON.parse(details ?? '{}'), id, jd, hasApplication: Boolean(applicationId) })),
    getJob(id) {
      const row = selectJob.get(id);
      if (!row) return undefined;
      return { ...JSON.parse(row.details ?? '{}'), id: row.id, jd: row.jd };
    },
    saveDiscoveredJob({ jd, ...details }) {
      // 同一来源重复返回同一岗位时保留职位 ID，已有投递继续关联该职位。
      const { kind, url, jobKey, locator } = details.source;
      const key = JSON.stringify([kind, url, jobKey || locator, jobKey ? null : details.city]);
      const existing = getDiscoveredJob.get(key);
      const serialized = JSON.stringify(details);
      if (existing) {
        updateJob.run(jd, existing.id);
        updateDiscovery.run(serialized, existing.id);
        return existing.id;
      }
      const id = randomUUID();
      insertJob.run(id, jd);
      insertDiscovery.run(id, key, serialized);
      return id;
    },
    getApplication: (jobId) => selectApplication.get(jobId),
    registerApplication(jobId) {
      // 由 SQLite 的唯一约束处理重复提交，保留原投递 ID。
      insertApplication.run(randomUUID(), jobId);
    },
  };
}
