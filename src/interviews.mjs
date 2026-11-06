import { randomUUID } from 'node:crypto';

export function createInterviewStore(db) {
  // 轮次归属于投递，更新职位时仍可通过原投递查看轮次。
  db.exec(`
    CREATE TABLE IF NOT EXISTS interview_rounds (
      id TEXT PRIMARY KEY NOT NULL,
      application_id TEXT NOT NULL REFERENCES applications (id),
      round_number INTEGER NOT NULL,
      scheduled_at TEXT,
      result TEXT CHECK (result IN ('passed', 'failed')),
      CHECK (scheduled_at IS NOT NULL OR result IS NOT NULL),
      UNIQUE (application_id, round_number)
    );
  `);

  const listRounds = db.prepare(`
    SELECT id, round_number AS roundNumber, scheduled_at AS scheduledAt, result
    FROM interview_rounds WHERE application_id = ? ORDER BY round_number
  `);
  const selectRound = db.prepare(`
    SELECT id, round_number AS roundNumber, scheduled_at AS scheduledAt, result
    FROM interview_rounds WHERE application_id = ? AND id = ?
  `);
  // 在同一条写语句中分配轮次序号，避免同时新增时竞争相同序号。
  const insertRound = db.prepare(`
    INSERT INTO interview_rounds (id, application_id, round_number, scheduled_at, result)
    SELECT ?, ?, COALESCE(MAX(round_number), 0) + 1, ?, ?
    FROM interview_rounds WHERE application_id = ?
  `);
  // 写入时同时匹配投递和轮次，避免误改另一条投递的记录。
  const updateRound = db.prepare(`
    UPDATE interview_rounds SET scheduled_at = ?, result = ?
    WHERE application_id = ? AND id = ?
  `);

  return {
    listRounds: (applicationId) => listRounds.all(applicationId),
    getRound: (applicationId, roundId) => selectRound.get(applicationId, roundId),
    addRound(applicationId, { scheduledAt, result }) {
      insertRound.run(randomUUID(), applicationId, scheduledAt, result, applicationId);
    },
    updateRound(applicationId, roundId, { scheduledAt, result }) {
      return updateRound.run(scheduledAt, result, applicationId, roundId).changes !== 0;
    },
  };
}
