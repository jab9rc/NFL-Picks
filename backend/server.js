const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { initDB, pool } = require('./db');
const { upsertWeekGames, scoreWeek } = require('./scraper');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'x-admin-key']
}));

// ─── Admin key middleware ──────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/current-week
// Returns the current open week's games (with spreads/O/U)
app.get('/api/current-week', async (req, res) => {
  try {
    const weekRes = await pool.query(`
      SELECT * FROM weeks
      WHERE status IN ('open','locked')
      ORDER BY season DESC, week DESC
      LIMIT 1
    `);

    if (!weekRes.rows.length) {
      return res.json({ week: null, games: [] });
    }

    const week = weekRes.rows[0];
    const gamesRes = await pool.query(`
      SELECT * FROM games WHERE week_id = $1 ORDER BY game_date, id
    `, [week.id]);

    res.json({ week, games: gamesRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/weeks
// Returns all available weeks (for week selector)
app.get('/api/weeks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, season, week, season_type, status, scraped_at, scored_at
      FROM weeks ORDER BY season DESC, week DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user-picks?name=John&weekId=1
// Returns a user's existing picks for a week
app.get('/api/user-picks', async (req, res) => {
  const { name, weekId } = req.query;
  if (!name || !weekId) return res.status(400).json({ error: 'name and weekId required' });

  try {
    const userRes = await pool.query(`SELECT id FROM users WHERE LOWER(name)=LOWER($1)`, [name]);
    if (!userRes.rows.length) return res.json({ picks: [] });

    const userId = userRes.rows[0].id;
    const picksRes = await pool.query(`
      SELECT p.*, g.espn_id FROM picks p
      JOIN games g ON g.id = p.game_id
      WHERE p.user_id = $1 AND g.week_id = $2
    `, [userId, weekId]);

    res.json({ picks: picksRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/picks
// Submit or update picks for a user
// Body: { name: "John", weekId: 1, picks: [{ gameId: 1, spreadPick: "home", ouPick: "over" }] }
app.post('/api/picks', async (req, res) => {
  const { name, weekId, picks } = req.body;
  if (!name || !weekId || !Array.isArray(picks)) {
    return res.status(400).json({ error: 'name, weekId, and picks[] required' });
  }
  if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });

  // Validate week is still open
  const weekCheck = await pool.query(`SELECT status FROM weeks WHERE id=$1`, [weekId]);
  if (!weekCheck.rows.length) return res.status(404).json({ error: 'Week not found' });
  // Allow 'open' or 'locked' — locked means some games started but we still accept
  // picks for games that haven't kicked off (simplified: just accept all)

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert user
    const userRes = await client.query(`
      INSERT INTO users (name) VALUES ($1)
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [name.trim()]);
    const userId = userRes.rows[0].id;

    let saved = 0;
    for (const pick of picks) {
      if (!pick.gameId) continue;
      await client.query(`
        INSERT INTO picks (user_id, game_id, spread_pick, ou_pick, submitted_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id, game_id)
        DO UPDATE SET
          spread_pick  = EXCLUDED.spread_pick,
          ou_pick      = EXCLUDED.ou_pick,
          submitted_at = NOW()
      `, [userId, pick.gameId, pick.spreadPick || null, pick.ouPick || null]);
      saved++;
    }

    await client.query('COMMIT');
    res.json({ success: true, saved, userId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/results?name=John&weekId=1
// Returns scored results + share card for a user/week
app.get('/api/results', async (req, res) => {
  const { name, weekId } = req.query;
  if (!name || !weekId) return res.status(400).json({ error: 'name and weekId required' });

  try {
    const userRes = await pool.query(`SELECT id FROM users WHERE LOWER(name)=LOWER($1)`, [name]);
    if (!userRes.rows.length) return res.json({ results: null });

    const userId = userRes.rows[0].id;

    const scoreRes = await pool.query(`
      SELECT * FROM weekly_scores WHERE user_id=$1 AND week_id=$2
    `, [userId, weekId]);

    if (!scoreRes.rows.length) {
      return res.json({ results: null, message: 'Not yet scored — check back Tuesday!' });
    }

    const score = scoreRes.rows[0];

    // Also return game-by-game detail
    const detailRes = await pool.query(`
      SELECT g.away_team, g.home_team, g.away_abbr, g.home_abbr,
             g.spread_pts, g.spread_fav, g.over_under,
             g.spread_result, g.ou_result, g.home_score, g.away_score,
             p.spread_pick, p.ou_pick, p.spread_correct, p.ou_correct
      FROM picks p
      JOIN games g ON g.id = p.game_id
      WHERE g.week_id = $1 AND p.user_id = $2
      ORDER BY g.game_date, g.id
    `, [weekId, userId]);

    res.json({
      results: score,
      games: detailRes.rows,
      shareCard: score.share_card
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leaderboard?weekId=1
// Returns all users' scores for a week
app.get('/api/leaderboard', async (req, res) => {
  const { weekId } = req.query;
  try {
    const query = weekId
      ? `SELECT u.name, ws.spread_correct, ws.spread_total, ws.ou_correct, ws.ou_total,
                ws.week_id, w.week, w.season
         FROM weekly_scores ws
         JOIN users u ON u.id = ws.user_id
         JOIN weeks w ON w.id = ws.week_id
         WHERE ws.week_id = $1
         ORDER BY (ws.spread_correct + ws.ou_correct) DESC`
      : `SELECT u.name,
                SUM(ws.spread_correct) as spread_correct,
                SUM(ws.spread_total) as spread_total,
                SUM(ws.ou_correct) as ou_correct,
                SUM(ws.ou_total) as ou_total
         FROM weekly_scores ws
         JOIN users u ON u.id = ws.user_id
         GROUP BY u.name
         ORDER BY (SUM(ws.spread_correct) + SUM(ws.ou_correct)) DESC`;

    const result = weekId
      ? await pool.query(query, [weekId])
      : await pool.query(query);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (require x-admin-key header)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/scrape
// Manually trigger a scrape for any week
// Body: { season: 2025, week: 1, seasonType: 2 }
app.post('/api/admin/scrape', requireAdmin, async (req, res) => {
  const { season, week, seasonType = 2 } = req.body;
  if (!season || !week) return res.status(400).json({ error: 'season and week required' });

  try {
    const result = await upsertWeekGames(season, week, seasonType);
    res.json({ success: true, weekId: result.weekId, games: result.games.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/score
// Manually trigger scoring for a week
// Body: { weekId: 1 }
app.post('/api/admin/score', requireAdmin, async (req, res) => {
  const { weekId } = req.body;
  if (!weekId) return res.status(400).json({ error: 'weekId required' });

  try {
    // First re-scrape to get latest scores
    const weekInfo = await pool.query(`SELECT * FROM weeks WHERE id=$1`, [weekId]);
    if (!weekInfo.rows.length) return res.status(404).json({ error: 'Week not found' });
    const w = weekInfo.rows[0];
    await upsertWeekGames(w.season, w.week, w.season_type);

    const result = await scoreWeek(weekId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users — list all users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.*, COUNT(p.id) as pick_count
      FROM users u LEFT JOIN picks p ON p.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/open-week
// Set a week's status to open (so users can pick)
app.post('/api/admin/open-week', requireAdmin, async (req, res) => {
  const { weekId } = req.body;
  try {
    await pool.query(`UPDATE weeks SET status='open' WHERE id=$1`, [weekId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON JOB — Every Tuesday at 10 AM ET
// 1. Re-fetch previous week's final scores and score user picks
// 2. Scrape upcoming week's lines
// ─────────────────────────────────────────────────────────────────────────────

cron.schedule('0 15 * * 2', async () => {
  // 15:00 UTC = 10:00 AM ET (EST), 11:00 AM ET (EDT)
  console.log('⏰ Tuesday cron running...');
  try {
    // 1. Find the most recently scored or open week
    const prevRes = await pool.query(`
      SELECT * FROM weeks
      WHERE status IN ('open','locked')
      ORDER BY season DESC, week DESC
      LIMIT 1
    `);

    if (prevRes.rows.length) {
      const prev = prevRes.rows[0];
      console.log(`📊 Scoring week ${prev.week} (id: ${prev.id})`);
      await upsertWeekGames(prev.season, prev.week, prev.season_type);
      await scoreWeek(prev.id);
    }

    // 2. Figure out next week (current NFL week + 1)
    // Get highest week we have
    const latestRes = await pool.query(`
      SELECT season, week, season_type FROM weeks
      ORDER BY season DESC, week DESC LIMIT 1
    `);

    if (latestRes.rows.length) {
      const latest = latestRes.rows[0];
      const nextWeek = latest.week + 1;
      const maxWeek = latest.season_type === 2 ? 18 : 4; // reg season 18 weeks

      if (nextWeek <= maxWeek) {
        console.log(`📡 Scraping week ${nextWeek}`);
        await upsertWeekGames(latest.season, nextWeek, latest.season_type);
        // Mark as open
        await pool.query(`
          UPDATE weeks SET status='open'
          WHERE season=$1 AND week=$2 AND season_type=$3
        `, [latest.season, nextWeek, latest.season_type]);
      }
    }

    console.log('✅ Tuesday cron complete');
  } catch (err) {
    console.error('❌ Cron error:', err.message);
  }
}, {
  timezone: 'America/New_York'
});

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🏈 NFL Picks API running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
