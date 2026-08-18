const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Weeks table: tracks each NFL week's metadata and lock status
      CREATE TABLE IF NOT EXISTS weeks (
        id          SERIAL PRIMARY KEY,
        season      INTEGER NOT NULL,
        week        INTEGER NOT NULL,
        season_type INTEGER NOT NULL DEFAULT 2,
        status      TEXT NOT NULL DEFAULT 'open',
        -- 'open' = accepting picks, 'locked' = game started, 'scored' = results in
        scraped_at  TIMESTAMPTZ,
        scored_at   TIMESTAMPTZ,
        UNIQUE(season, week, season_type)
      );

      -- Games table: one row per game per week
      CREATE TABLE IF NOT EXISTS games (
        id            SERIAL PRIMARY KEY,
        week_id       INTEGER REFERENCES weeks(id) ON DELETE CASCADE,
        espn_id       TEXT NOT NULL,
        home_team     TEXT NOT NULL,
        away_team     TEXT NOT NULL,
        home_abbr     TEXT NOT NULL,
        away_abbr     TEXT NOT NULL,
        game_date     TIMESTAMPTZ,
        spread_line   NUMERIC(5,1),   -- negative = home favored
        spread_fav    TEXT,           -- 'home' or 'away'
        spread_pts    NUMERIC(5,1),   -- absolute value of spread
        over_under    NUMERIC(5,1),
        home_score    INTEGER,        -- null until game over
        away_score    INTEGER,
        spread_result TEXT,           -- 'home_cover','away_cover','push' after scoring
        ou_result     TEXT,           -- 'over','under','push' after scoring
        UNIQUE(week_id, espn_id)
      );

      -- Users table: name-based, created on first pick submission
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Picks table: one row per user per game
      CREATE TABLE IF NOT EXISTS picks (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        game_id      INTEGER REFERENCES games(id) ON DELETE CASCADE,
        spread_pick  TEXT,   -- 'home' or 'away' (who they think covers)
        ou_pick      TEXT,   -- 'over' or 'under'
        spread_correct BOOLEAN,
        ou_correct     BOOLEAN,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, game_id)
      );

      -- Weekly scores table: cached summary per user per week
      CREATE TABLE IF NOT EXISTS weekly_scores (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        week_id         INTEGER REFERENCES weeks(id) ON DELETE CASCADE,
        spread_correct  INTEGER DEFAULT 0,
        spread_total    INTEGER DEFAULT 0,
        ou_correct      INTEGER DEFAULT 0,
        ou_total        INTEGER DEFAULT 0,
        share_card      TEXT,
        scored_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, week_id)
      );
    `);
    console.log('✅ Database schema ready');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
