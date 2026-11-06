import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDiscoveryStore } from './discovered-jobs.mjs';

function protectDatabaseFile(file, optional = false) {
  const { O_CREAT, O_NOFOLLOW, O_NONBLOCK, O_RDWR } = constants;
  let fd;
  try {
    fd = openSync(file, O_RDWR | O_NOFOLLOW | O_NONBLOCK | (optional ? 0 : O_CREAT), 0o600);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid()) {
      throw new Error('SQLite 文件必须是本机用户独占的普通文件');
    }
    // 通过文件描述符收紧旧文件权限，避免 chmod 跟随替换后的路径。
    if ((info.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export function openDatabase(dataDir) {
  const directoryPath = resolve(dataDir);
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const directory = lstatSync(directoryPath);
  if (!directory.isDirectory() || directory.uid !== process.geteuid() || (directory.mode & 0o022)) {
    throw new Error('数据目录必须由本机用户控制，其他用户不能写入');
  }
  // 关键：先以私有权限建库，SQLite 新建的事务文件继承主文件的权限。
  const file = join(directoryPath, 'job-search.sqlite');
  protectDatabaseFile(file);
  for (const suffix of ['-journal', '-wal', '-shm']) protectDatabaseFile(file + suffix, true);
  const db = new DatabaseSync(file);
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

  const discoveries = createDiscoveryStore(db);
  const resolveJobId = db.prepare('SELECT job_id AS id FROM job_aliases WHERE id = ?');
  const canonical = id => resolveJobId.get(id)?.id ?? id;
  const selectJobs = db.prepare(`
    SELECT jobs.id, jobs.jd, discovered_jobs.details, applications.id IS NOT NULL AS hasApplication,
      EXISTS (SELECT 1 FROM manual_jds WHERE job_id = jobs.id) AS isManual
    FROM jobs LEFT JOIN discovered_jobs ON discovered_jobs.job_id = jobs.id
    LEFT JOIN applications ON applications.job_id = jobs.id
    ORDER BY COALESCE(json_extract(discovered_jobs.details, '$.changedAt'),
      json_extract(discovered_jobs.details, '$.firstDiscoveredAt'),
      json_extract(discovered_jobs.details, '$.source.verifiedAt')) DESC, jobs.rowid DESC
  `);
  const selectJob = db.prepare(`
    SELECT jobs.id, jobs.jd, discovered_jobs.details
    FROM jobs LEFT JOIN discovered_jobs ON discovered_jobs.job_id = jobs.id WHERE jobs.id = ?
  `);
  const insertApplication = db.prepare(`
    INSERT INTO applications (id, job_id) VALUES (?, ?)
    ON CONFLICT (job_id) DO NOTHING
  `);
  const selectApplication = db.prepare('SELECT id, job_id AS jobId FROM applications WHERE job_id = ?');

  return {
    addManualJob: discoveries.addManual,
    listJobs: () => selectJobs.all().map(({ id, jd, details, hasApplication, isManual }) => ({
      ...JSON.parse(details ?? '{}'), id, jd, hasApplication: Boolean(hasApplication), isManual: Boolean(isManual),
    })),
    getJob(id) {
      const row = selectJob.get(canonical(id));
      if (!row) return undefined;
      const sources = discoveries.readSources(row.id);
      return { ...JSON.parse(row.details ?? '{}'), id: row.id, jd: row.jd, isManual: sources.manualJds.length > 0, ...sources };
    },
    saveDiscoveredJob: discoveries.save,
    getApplication: (jobId) => selectApplication.get(canonical(jobId)),
    registerApplication(jobId) {
      // 由 SQLite 的唯一约束处理重复提交，保留原投递 ID。
      insertApplication.run(randomUUID(), jobId);
    },
  };
}
