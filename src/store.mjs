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
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs (id)
    );
  `);

  const insertJob = db.prepare('INSERT INTO jobs (id, jd) VALUES (?, ?)');
  const selectJobs = db.prepare('SELECT id, jd FROM jobs ORDER BY rowid DESC');
  const selectJob = db.prepare('SELECT id, jd FROM jobs WHERE id = ?');
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
    listJobs: () => selectJobs.all(),
    getJob: (id) => selectJob.get(id),
    getApplication: (jobId) => selectApplication.get(jobId),
    registerApplication(jobId) {
      // 由 SQLite 的唯一约束处理重复提交，保留原投递 ID。
      insertApplication.run(randomUUID(), jobId);
    },
  };
}
