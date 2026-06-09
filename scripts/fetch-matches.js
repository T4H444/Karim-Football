const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const API_KEY    = process.env.FOOTBALL_API_KEY;
const BASE_URL   = 'https://v3.football.api-sports.io';
const today      = new Date().toISOString().split('T')[0];

// Max parallel livesoccertv requests (be polite, but not glacial)
const TV_CONCURRENCY = 8;
// Timeout per TV lookup — was 8000, now tighter
const TV_TIMEOUT_MS  = 3000;

// ─── CHANNEL WHITELIST ────────────────────────────────────
// Only show channels relevant to Morocco / North Africa / Arab world / France
const CHANNEL_WHITELIST = [
  'bein', 'beIN', 'bein sports',
  '2M', 'Al Aoula', 'Arryadia',
  'MBC', 'Al Jazeera', 'Al Kass',
  'SSC', 'Saudi',
  'TOD',
  'TF1', 'W9', 'M6', 'France 2', 'France 3',
  'Canal+', 'Canal Plus',
  'FIFA+',
  'YouTube',
  'DAZN',
  'OSN',
  'Shahid',
];

function isRelevantChannel(name) {
  const lower = name.toLowerCase();
  return CHANNEL_WHITELIST.some(w => lower.includes(w.toLowerCase()));
}

// ─── SLUGIFY team name for livesoccertv URL ───────────────
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .trim();
}

// ─── PARALLEL POOL ────────────────────────────────────────
// Runs `tasks` (array of async functions) with at most `limit` concurrent.
async function poolAll(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── FETCH TV CHANNELS from livesoccertv-parser ───────────
async function getTvChannels(home, away) {
  try {
    const { getMatches } = require('livesoccertv-parser');
    const homeSlug = slugify(home);

    const results = await Promise.race([
      getMatches('international', homeSlug, { timezone: 'Africa/Casablanca' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TV_TIMEOUT_MS))
    ]);

    if (!results || results.length === 0) return [];

    const match = results.find(r => {
      const game = (r.game || '').toLowerCase();
      return game.includes(slugify(away).replace(/-/g, ' ')) ||
             game.includes(away.toLowerCase());
    });

    if (!match || !match.tvs) return [];

    return match.tvs.filter(isRelevantChannel);
  } catch {
    return [];
  }
}

// ─── STATUS PARSER ────────────────────────────────────────
function parseStatus(fixture, goals) {
  const s = fixture.status.short;

  if (s === 'FT' || s === 'AET' || s === 'PEN') {
    return { type: 'finished', label: 'FT', homeScore: goals.home, awayScore: goals.away };
  }
  if (s === 'HT') {
    return { type: 'halftime', label: 'HT', homeScore: goals.home, awayScore: goals.away };
  }
  if (['1H', '2H', 'ET', 'LIVE'].includes(s)) {
    return { type: 'live', label: 'LIVE', homeScore: goals.home, awayScore: goals.away };
  }
  if (s === 'NS') {
    const d = new Date(fixture.date);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return { type: 'scheduled', label: `${hh}:${mm}`, homeScore: null, awayScore: null };
  }
  if (s === 'PST') return { type: 'postponed', label: 'PPD', homeScore: null, awayScore: null };
  if (s === 'CANC') return { type: 'cancelled', label: 'CANC', homeScore: null, awayScore: null };

  return { type: 'unknown', label: s, homeScore: null, awayScore: null };
}

// ─── MAIN ─────────────────────────────────────────────────
async function fetchMatches() {
  if (!API_KEY) {
    console.error('❌  FOOTBALL_API_KEY is not set.');
    process.exit(1);
  }

  console.log(`📅  Fetching matches for ${today}…`);

  let data;
  try {
    const res = await fetch(`${BASE_URL}/fixtures?date=${today}`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    if (!res.ok) {
      console.error(`❌  API error ${res.status}:`, await res.text());
      process.exit(1);
    }
    data = await res.json();
  } catch (err) {
    console.error('❌  Network error:', err.message);
    process.exit(1);
  }

  const rawMatches = data.response || [];
  console.log(`✅  ${rawMatches.length} matches received`);

  // ── Build match objects ───────────────────────────────
  const matches = rawMatches
    .map(item => {
      const { fixture, teams, goals, league } = item;
      const status = parseStatus(fixture, goals);
      return {
        id:              fixture.id,
        competition:     league.name || 'Unknown',
        competitionFlag: '⚽',
        competitionCode: league.id,
        home:            teams.home.name || 'TBD',
        away:            teams.away.name || 'TBD',
        homeLogo:        teams.home.logo || null,
        awayLogo:        teams.away.logo || null,
        utcDate:         fixture.date,
        status:          status.type,
        statusLabel:     status.label,
        homeScore:       status.homeScore,
        awayScore:       status.awayScore,
        channels:        [],
      };
    })
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  // ── Fetch TV channels for each match ─────────────────
  // FIX: track whether channels were *attempted* today (not just found),
  // so we don't re-run on every 20min refresh even when all channels are empty.
  const outPath = path.join(__dirname, '..', 'data', 'matches.json');
  let existingChannels = {};
  let channelsAlreadyFetchedToday = false;

  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (existing.date === today && existing.channelsFetchedAt) {
        // Channels were fetched at some point today — reuse regardless of whether any matched
        channelsAlreadyFetchedToday = true;
        existing.matches.forEach(m => {
          existingChannels[m.id] = m.channels || [];
        });
        console.log(`📺  Reusing channel data from ${existing.channelsFetchedAt} (${Object.keys(existingChannels).length} matches cached)`);
      }
    } catch (e) {}
  }

  if (!channelsAlreadyFetchedToday) {
    console.log(`📺  Fetching TV channels in parallel (concurrency=${TV_CONCURRENCY}, timeout=${TV_TIMEOUT_MS}ms)…`);
    const start = Date.now();

    // FIX: parallel pool instead of sequential loop — no per-item delay
    const tasks = matches.map(match => async () => {
      match.channels = await getTvChannels(match.home, match.away);
      if (match.channels.length > 0) {
        console.log(`  ✅  ${match.home} vs ${match.away}: ${match.channels.join(', ')}`);
      }
    });

    await poolAll(tasks, TV_CONCURRENCY);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`📺  TV channel fetch done in ${elapsed}s`);
  } else {
    matches.forEach(m => {
      m.channels = existingChannels[m.id] || [];
    });
  }

  // ── Write output ──────────────────────────────────────
  const output = {
    date:               today,
    fetchedAt:          new Date().toISOString(),
    // FIX: stamp when channels were fetched so subsequent runs know to skip
    channelsFetchedAt:  channelsAlreadyFetchedToday
      ? (JSON.parse(fs.readFileSync(outPath, 'utf8')).channelsFetchedAt)
      : new Date().toISOString(),
    total:              matches.length,
    matches,
  };

  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`💾  Saved ${matches.length} matches → data/matches.json`);
}

fetchMatches();
