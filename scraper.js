const axios = require('axios');
const cheerio = require('cheerio');
const { pool } = require('./db');

// ─── ESPN Odds API (undocumented but stable) ───────────────────────────────
// ESPN exposes odds data via their internal API which backs the website.
// We hit the scoreboard endpoint which includes odds when available.

const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ESPN_ODDS = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events';

async function fetchWeekGames(season, week, seasonType = 2) {
  console.log(`📡 Fetching ESPN data: Season ${season}, Week ${week}`);

  try {
    // Primary: ESPN scoreboard API with odds
    const url = `${ESPN_API}?seasontype=${seasonType}&season=${season}&week=${week}&limit=20`;
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    const events = data?.events || [];
    if (!events.length) {
      throw new Error(`No games found for Season ${season} Week ${week}`);
    }

    const games = [];
    for (const event of events) {
      try {
        const game = parseEvent(event);
        if (game) games.push(game);
      } catch (e) {
        console.warn(`⚠️  Could not parse event ${event.id}:`, e.message);
      }
    }

    console.log(`✅ Parsed ${games.length} games`);
    return games;

  } catch (err) {
    console.error('❌ ESPN fetch error:', err.message);
    throw err;
  }
}

function parseEvent(event) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  // Scores (null if game hasn't been played)
  const homeScore = competition.status?.type?.completed
    ? parseInt(home.score || '0')
    : null;
  const awayScore = competition.status?.type?.completed
    ? parseInt(away.score || '0')
    : null;

  // Odds — ESPN embeds these in competition.odds
  let spreadLine = null;
  let overUnder = null;
  let spreadFav = null;
  let spreadPts = null;

  const odds = competition.odds?.[0];
  if (odds) {
    // details looks like "SEA -3.5" or "NE +3.5"
    const detail = odds.details || '';
    const ouVal = odds.overUnder;
    overUnder = ouVal ? parseFloat(ouVal) : null;

    // Parse spread from details string
    const spreadMatch = detail.match(/^([A-Z]+)\s+([-+]?\d+\.?\d*)$/);
    if (spreadMatch) {
      const favAbbr = spreadMatch[1].toUpperCase();
      const pts = parseFloat(spreadMatch[2]);
      spreadPts = Math.abs(pts);

      const homeAbbr = home.team?.abbreviation?.toUpperCase();
      const awayAbbr = away.team?.abbreviation?.toUpperCase();

      // Negative spread = favored team; detail shows the favored team
      if (favAbbr === homeAbbr) {
        spreadFav = 'home';
        spreadLine = -spreadPts; // home favored
      } else if (favAbbr === awayAbbr) {
        spreadFav = 'away';
        spreadLine = spreadPts; // away favored (positive from home perspective)
      } else {
        // Try partial match
        if (homeAbbr && homeAbbr.includes(favAbbr)) {
          spreadFav = 'home';
          spreadLine = -spreadPts;
        } else {
          spreadFav = 'away';
          spreadLine = spreadPts;
        }
      }
    }
  }

  return {
    espn_id: event.id,
    home_team: home.team?.displayName || home.team?.name || 'Unknown',
    away_team: away.team?.displayName || away.team?.name || 'Unknown',
    home_abbr: home.team?.abbreviation?.toUpperCase() || 'HM',
    away_abbr: away.team?.abbreviation?.toUpperCase() || 'AW',
    game_date: event.date || null,
    spread_line: spreadLine,
    spread_fav: spreadFav,
    spread_pts: spreadPts,
    over_under: overUnder,
    home_score: homeScore,
    away_score: awayScore,
    completed: competition.status?.type?.completed || false
  };
}

// ─── Save games to DB ──────────────────────────────────────────────────────

async function upsertWeekGames(season, week, seasonType = 2) {
  const games = await fetchWeekGames(season, week, seasonType);
  if (!games.length) return { weekId: null, games: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert week record
    const weekRes = await client.query(`
      INSERT INTO weeks (season, week, season_type, scraped_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (season, week, season_type)
      DO UPDATE SET scraped_at = NOW()
      RETURNING id
    `, [season, week, seasonType]);
    const weekId = weekRes.rows[0].id;

    // Upsert each game
    const savedGames = [];
    for (const g of games) {
      const res = await client.query(`
        INSERT INTO games (
          week_id, espn_id, home_team, away_team, home_abbr, away_abbr,
          game_date, spread_line, spread_fav, spread_pts, over_under,
          home_score, away_score
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (week_id, espn_id)
        DO UPDATE SET
          spread_line = EXCLUDED.spread_line,
          spread_fav  = EXCLUDED.spread_fav,
          spread_pts  = EXCLUDED.spread_pts,
          over_under  = EXCLUDED.over_under,
          home_score  = EXCLUDED.home_score,
          away_score  = EXCLUDED.away_score
        RETURNING *
      `, [
        weekId, g.espn_id, g.home_team, g.away_team,
        g.home_abbr, g.away_abbr, g.game_date,
        g.spread_line, g.spread_fav, g.spread_pts, g.over_under,
        g.home_score, g.away_score
      ]);
      savedGames.push(res.rows[0]);
    }

    await client.query('COMMIT');
    console.log(`💾 Saved week ${week} to DB (weekId: ${weekId})`);
    return { weekId, games: savedGames };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Score a completed week ────────────────────────────────────────────────

async function scoreWeek(weekId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all completed games for this week
    const gamesRes = await client.query(`
      SELECT * FROM games WHERE week_id = $1
    `, [weekId]);

    const games = gamesRes.rows;
    let scoredCount = 0;

    for (const game of games) {
      if (game.home_score === null || game.away_score === null) continue;

      const homeScore = game.home_score;
      const awayScore = game.away_score;
      const total = homeScore + awayScore;
      const spreadLine = parseFloat(game.spread_line || 0);
      const overUnder = parseFloat(game.over_under || 0);

      // Spread result: spreadLine is from HOME perspective (negative = home favored)
      // Home covers if: homeScore - awayScore > -spreadLine (i.e., home margin > spread)
      let spreadResult = null;
      if (game.spread_pts !== null) {
        const margin = homeScore - awayScore; // positive = home won
        const atsLine = -spreadLine; // how many points home needs to cover
        if (Math.abs(margin - atsLine) < 0.1) {
          spreadResult = 'push';
        } else if (margin > atsLine) {
          spreadResult = 'home_cover';
        } else {
          spreadResult = 'away_cover';
        }
      }

      // O/U result
      let ouResult = null;
      if (game.over_under !== null) {
        if (Math.abs(total - overUnder) < 0.1) {
          ouResult = 'push';
        } else if (total > overUnder) {
          ouResult = 'over';
        } else {
          ouResult = 'under';
        }
      }

      await client.query(`
        UPDATE games SET spread_result = $1, ou_result = $2
        WHERE id = $3
      `, [spreadResult, ouResult, game.id]);
      scoredCount++;
    }

    // Now score all user picks for this week
    const picksRes = await client.query(`
      SELECT p.*, g.spread_result, g.ou_result
      FROM picks p
      JOIN games g ON g.id = p.game_id
      WHERE g.week_id = $1 AND g.spread_result IS NOT NULL
    `, [weekId]);

    for (const pick of picksRes.rows) {
      const spreadCorrect = pick.spread_pick === null ? null :
        (pick.spread_result === 'push' ? null :
         pick.spread_pick === 'home' ? pick.spread_result === 'home_cover' :
         pick.spread_result === 'away_cover');

      const ouCorrect = pick.ou_pick === null ? null :
        (pick.ou_result === 'push' ? null :
         pick.ou_pick === pick.ou_result);

      await client.query(`
        UPDATE picks SET spread_correct = $1, ou_correct = $2
        WHERE id = $3
      `, [spreadCorrect, ouCorrect, pick.id]);
    }

    // Build weekly score summaries per user
    const usersRes = await client.query(`
      SELECT DISTINCT p.user_id FROM picks p
      JOIN games g ON g.id = p.game_id
      WHERE g.week_id = $1
    `, [weekId]);

    const weekInfo = await client.query(`
      SELECT w.*, u.name FROM picks p
      JOIN games g ON g.id = p.game_id
      JOIN weeks w ON w.id = g.week_id
      JOIN users u ON u.id = p.user_id
      WHERE g.week_id = $1
      LIMIT 1
    `, [weekId]);
    const weekRow = await client.query(`SELECT * FROM weeks WHERE id = $1`, [weekId]);

    for (const { user_id } of usersRes.rows) {
      const scoreRes = await client.query(`
        SELECT
          COUNT(CASE WHEN p.spread_correct = true THEN 1 END) as spread_correct,
          COUNT(CASE WHEN p.spread_correct IS NOT NULL THEN 1 END) as spread_total,
          COUNT(CASE WHEN p.ou_correct = true THEN 1 END) as ou_correct,
          COUNT(CASE WHEN p.ou_correct IS NOT NULL THEN 1 END) as ou_total
        FROM picks p
        JOIN games g ON g.id = p.game_id
        WHERE g.week_id = $1 AND p.user_id = $2
      `, [weekId, user_id]);

      const s = scoreRes.rows[0];
      const sc = parseInt(s.spread_correct || 0);
      const st = parseInt(s.spread_total || 0);
      const oc = parseInt(s.ou_correct || 0);
      const ot = parseInt(s.ou_total || 0);

      // Build share card
      const userRes = await client.query(`SELECT name FROM users WHERE id = $1`, [user_id]);
      const userName = userRes.rows[0]?.name || 'Player';
      const wk = weekRow.rows[0];

      // Game-by-game detail
      const detailRes = await client.query(`
        SELECT g.away_team, g.home_team, g.away_abbr, g.home_abbr,
               g.spread_pts, g.spread_fav, g.over_under,
               g.spread_result, g.ou_result,
               p.spread_pick, p.ou_pick, p.spread_correct, p.ou_correct
        FROM picks p
        JOIN games g ON g.id = p.game_id
        WHERE g.week_id = $1 AND p.user_id = $2
        ORDER BY g.game_date, g.id
      `, [weekId, user_id]);

      let card = `NFL Picks · Week ${wk.week}\n`;
      card += `${sc}/${st} Correct Spreads\n`;
      card += `${oc}/${ot} Correct O/U\n\n`;

      for (const row of detailRes.rows) {
        const spreadEmoji = row.spread_correct === true ? '🟢' : row.spread_correct === false ? '🔴' : '⚪';
        const ouEmoji = row.ou_correct === true ? '🟢' : row.ou_correct === false ? '🔴' : '⚪';

        const favTeam = row.spread_fav === 'home' ? row.home_abbr : row.away_abbr;
        const spreadStr = row.spread_pts ? `${favTeam} -${row.spread_pts}` : 'PK';
        const ouStr = row.over_under ? `O/U: ${row.over_under}` : 'N/A';

        // Who user picked to cover
        const pickedAbbr = row.spread_pick === 'home' ? row.home_abbr :
                           row.spread_pick === 'away' ? row.away_abbr : '–';
        const ouPickStr = row.ou_pick ? row.ou_pick.charAt(0).toUpperCase() + row.ou_pick.slice(1) : '–';

        card += `${row.away_abbr} @ ${row.home_abbr}\n`;
        card += `${spreadStr} → Pick: ${pickedAbbr} ${spreadEmoji}\n`;
        card += `${ouStr} → Pick: ${ouPickStr} ${ouEmoji}\n\n`;
      }

      await client.query(`
        INSERT INTO weekly_scores (user_id, week_id, spread_correct, spread_total, ou_correct, ou_total, share_card, scored_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (user_id, week_id)
        DO UPDATE SET
          spread_correct = EXCLUDED.spread_correct,
          spread_total   = EXCLUDED.spread_total,
          ou_correct     = EXCLUDED.ou_correct,
          ou_total       = EXCLUDED.ou_total,
          share_card     = EXCLUDED.share_card,
          scored_at      = NOW()
      `, [user_id, weekId, sc, st, oc, ot, card]);
    }

    // Mark week as scored
    await client.query(`UPDATE weeks SET status='scored', scored_at=NOW() WHERE id=$1`, [weekId]);
    await client.query('COMMIT');

    console.log(`✅ Scored week ${weekId}: ${scoredCount} games, ${usersRes.rows.length} users`);
    return { scoredGames: scoredCount, scoredUsers: usersRes.rows.length };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { fetchWeekGames, upsertWeekGames, scoreWeek };
