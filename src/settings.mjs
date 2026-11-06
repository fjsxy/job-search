export function createSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fast_mode INTEGER NOT NULL CHECK (fast_mode IN (0, 1)),
      direction TEXT NOT NULL
    );
    INSERT OR IGNORE INTO agent_settings (id, fast_mode, direction) VALUES (1, 1, '');
  `);
  const get = db.prepare('SELECT fast_mode AS fastMode, direction FROM agent_settings WHERE id = 1');
  const saveSpeed = db.prepare('UPDATE agent_settings SET fast_mode = ? WHERE id = 1');
  const saveDirection = db.prepare('UPDATE agent_settings SET direction = ? WHERE id = 1');
  return {
    get() {
      const { fastMode, direction } = get.get();
      return { fastMode: Boolean(fastMode), direction };
    },
    saveSpeed: (fastMode) => saveSpeed.run(Number(fastMode)),
    saveDirection: (direction) => saveDirection.run(direction),
  };
}
