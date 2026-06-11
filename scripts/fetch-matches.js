const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const API_KEY  = process.env.FOOTBALL_API_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';
const today    = new Date().toISOString().split('T')[0];

// ─── CHANNEL DATA ─────────────────────────────────────────
// These are the confirmed MENA/France/North-Africa broadcasters
// pulled from livesoccertv.com and official rights confirmations.
// Updated June 2026 (World Cup season).

const CHANNEL_WHITELIST = [
  // ── Morocco (SNRT/free-to-air) ──
  'arryadia', 'arriyadiya', 'al arryadia',
  'al aoula', 'snrt',
  '2m maroc', '2m',
  // ── Pan-MENA (beIN) ──
  'bein', 'bein sports', 'bein sport',
  'bein sports max', 'bein max',
  'tod',                           // beIN's OTT platform
  // ── Saudi / Gulf ──
  'ssc',                           // Saudi Sports Channel
  'thamaniya', 'channel 8',        // Saudi free sports
  'saudi sports', 'sbc',
  'ksa sports',
  // ── Pan-Arab ──
  'al jazeera', 'aljazeera',
  'al kass', 'alkass',
  'abu dhabi sports', 'abu dhabi',
  'osn sports', 'osn',
  'rotana sport', 'rotana',
  'dubai sports',
  // ── Egypt / Levant ──
  'on sport', 'on time sport', 'on time',
  'mbc masr', 'mbc action', 'mbc',
  'nile sport',
  'ssportplus', 'ssport',
  // ── France ──
  'tf1', 'tf1+', 'tmc',
  'm6', 'm6+', 'w9',
  'france 2', 'france 3', 'france 4', 'france.tv',
  'canal+', 'canal plus', 'canal sport',
  'rmc sport', 'rmc bfm',
  "l'equipe", 'lequipe',
  'eurosport',
  // ── Shahid / OTT ──
  'shahid', 'shahid vip',
  // ── Global / Digital ──
  'dazn',
  'fifa+',
  'youtube',
  'bbc one', 'bbc two', 'bbc iplayer',    // UK (relevant for WC)
  'itv', 'itv1',
  'cbs sports',
];

// ─── KNOWN STATIC CHANNELS BY COMPETITION ─────────────────
// For competitions where MENA rights are known and the scraper
// won't find them (because livesoccertv shows by country).
// These are injected automatically so cards always have data.
const COMPETITION_CHANNELS = {
  // World Cup 2026 — MENA confirmed rights
  'world cup':         ['beIN Sports', 'Arryadia', 'Al Aoula', 'TOD'],
  'fifa world cup':    ['beIN Sports', 'Arryadia', 'Al Aoula', 'TOD'],
  // Africa Cup of Nations
  'africa cup':        ['beIN Sports', 'Arryadia', 'Al Aoula'],
  'afcon':             ['beIN Sports', 'Arryadia', 'Al Aoula'],
  // Champions League
  'champions league':  ['beIN Sports', 'TOD'],
  'uefa champions':    ['beIN Sports', 'TOD'],
  // Europa / Conference
  'europa league':     ['beIN Sports', 'TOD'],
  'conference league': ['beIN Sports', 'TOD'],
  // Premier League
  'premier league':    ['beIN Sports', 'TOD'],
  // La Liga
  'la liga':           ['beIN Sports', 'TOD'],
  'primera division':  ['beIN Sports', 'TOD'],
  // Serie A
  'serie a':           ['beIN Sports', 'TOD'],
  // Bundesliga
  'bundesliga':        ['beIN Sports', 'TOD'],
  // Ligue 1 — France (free-to-air + beIN)
  'ligue 1':           ['beIN Sports', 'Canal+', 'TOD'],
  // Friendlies — often SNRT for Morocco matches, beIN for others
  'friendlies':        ['beIN Sports'],
  'friendly':          ['beIN Sports'],
  // World Cup qualifying
  'world cup qualifying': ['beIN Sports', 'Arryadia'],
  'afcon qualification':  ['beIN Sports', 'Arryadia'],
};

function getStaticChannels(competitionName) {
  const lower = (competitionName || '').toLowerCase();
  for (const [key, channels] of Object.entries(COMPETITION_CHANNELS)) {
    if (lower.includes(key)) return channels;
  }
  return [];
}

// ─── CHANNEL NAME NORMALIZER ─────────────────────────────
// Strips trailing numbers like "beIN Sports 1" → "beIN Sports"
function normalizeChannel(name) {
  return name
    .replace(/\s+(max\s*)?\d+(\s*hd)?$/i, '') // strip trailing number (and optional HD/MAX)
    .replace(/\s*hd$/i, '')
    .trim();
}

function isRelevantChannel(name) {
  const lower = name.toLowerCase();
  return CHANNEL_WHITELIST.some(w => lower.includes(w.toLowerCase()));
}

function dedupeChannels(arr) {
  const seen = new Set();
  return arr.filter(ch => {
    const norm = normalizeChannel(ch).toLowerCase();
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  }).map(normalizeChannel);
}

// ─── SCRAPE livesoccertv.com/schedules/DATE/ ─────────────
// Returns a map: { "Home Team vs Away Team" (lowercased) → [channels] }
async function scrapeSchedulePage(date) {
  const url = `https://www.livesoccertv.com/schedules/${date}/`;
  const channelMap = {};

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FootballBot/1.0)',
        'Accept': 'text/html',
      },
      timeout: 12000,
    });
    if (!res.ok) {
      console.warn(`⚠️  livesoccertv schedule page returned ${res.status}`);
      return channelMap;
    }

    const html = await res.text();

    // Each match row looks like:
    // <a href="/match/team-vs-team/id">Team A vs Team B</a>  channel1, channel2
    // We parse via regex on the raw HTML

    // Pattern: match links + their sibling channel anchor texts
    // Example row in HTML:
    //   <a href="/match/...">Team A vs Team B</a> ... <a href="/channels/bein-sports/">beIN Sports 1</a> ...
    // Strategy: find each match block, collect its channels

    const matchBlockRegex = /<a[^>]+href="\/match\/[^"]*"[^>]*>([^<]+vs[^<]+)<\/a>([\s\S]*?)(?=<a[^>]+href="\/match\/|<\/ul>)/gi;
    const channelRegex    = /<a[^>]+href="\/channels\/[^"]*"[^>]*>([^<]+)<\/a>/gi;

    let block;
    while ((block = matchBlockRegex.exec(html)) !== null) {
      const matchName = block[1].trim().toLowerCase();
      const blockText = block[2];

      const channels = [];
      let chMatch;
      const chRe = /<a[^>]+href="\/channels\/[^"]*"[^>]*>([^<]+)<\/a>/gi;
      while ((chMatch = chRe.exec(blockText)) !== null) {
        const ch = chMatch[1].trim();
        if (isRelevantChannel(ch)) channels.push(ch);
      }

      if (channels.length > 0 || matchName) {
        channelMap[matchName] = dedupeChannels(channels);
      }
    }

    console.log(`📺  livesoccertv scraped: ${Object.keys(channelMap).length} matches with channel data`);
  } catch (err) {
    console.warn(`⚠️  livesoccertv scrape failed: ${err.message}`);
  }

  return channelMap;
}

// ─── MATCH LIVESOCCERTV DATA TO API MATCH ────────────────
function lookupChannels(match, channelMap) {
  // Try different name orderings
  const attempts = [
    `${match.home} vs ${match.away}`,
    `${match.away} vs ${match.home}`,
  ].map(s => s.toLowerCase());

  for (const key of attempts) {
    if (channelMap[key]) return channelMap[key];
  }

  // Fuzzy: partial match on team names
  const homeL = match.home.toLowerCase();
  const awayL = match.away.toLowerCase();
  for (const [key, chs] of Object.entries(channelMap)) {
    if (key.includes(homeL) || key.includes(awayL)) return chs;
  }

  return null;
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
  if (s === 'PST')  return { type: 'postponed',  label: 'PPD',  homeScore: null, awayScore: null };
  if (s === 'CANC') return { type: 'cancelled',  label: 'CANC', homeScore: null, awayScore: null };

  return { type: 'unknown', label: s, homeScore: null, awayScore: null };
}

// ─── MAIN ─────────────────────────────────────────────────
async function fetchMatches() {
  if (!API_KEY) {
    console.error('❌  FOOTBALL_API_KEY is not set.');
    process.exit(1);
  }

  console.log(`📅  Fetching matches for ${today}…`);

  // ── Step 1: Fetch fixtures from API ───────────────────
  let data;
  try {
    const res = await fetch(`${BASE_URL}/fixtures?date=${today}`, {
      headers: { 'x-apisports-key': API_KEY },
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
  console.log(`✅  ${rawMatches.length} matches received from API`);

  // ── Step 2: Build match objects ───────────────────────
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

  // ── Step 3: Check if channels already fetched today ───
  const outPath = path.join(__dirname, '..', 'data', 'matches.json');
  let channelsAlreadyFetchedToday = false;
  let existingChannels = {};

  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (existing.date === today && existing.channelsFetchedAt) {
        channelsAlreadyFetchedToday = true;
        existing.matches.forEach(m => {
          existingChannels[m.id] = m.channels || [];
        });
        console.log(`📺  Reusing channel data from ${existing.channelsFetchedAt}`);
      }
    } catch (e) {}
  }

  // ── Step 4: Fetch TV channels ─────────────────────────
  if (!channelsAlreadyFetchedToday) {
    console.log(`📺  Scraping livesoccertv.com for today's channel listings…`);

    // Scrape the daily schedule page (most efficient — one request)
    const channelMap = await scrapeSchedulePage(today);

    let withChannels = 0;
    for (const match of matches) {
      // Try livesoccertv scraped data first
      const scraped = lookupChannels(match, channelMap);
      if (scraped && scraped.length > 0) {
        match.channels = scraped;
        withChannels++;
        console.log(`  ✅  ${match.home} vs ${match.away}: ${match.channels.join(', ')}`);
      } else {
        // Fall back to static rights data per competition
        const staticChs = getStaticChannels(match.competition);
        if (staticChs.length > 0) {
          match.channels = staticChs;
          withChannels++;
        }
      }
    }

    console.log(`📺  ${withChannels}/${matches.length} matches have channel data`);
  } else {
    matches.forEach(m => {
      m.channels = existingChannels[m.id] || [];
    });
  }

  // ── Step 5: Write output ──────────────────────────────
  const output = {
    date:              today,
    fetchedAt:         new Date().toISOString(),
    channelsFetchedAt: channelsAlreadyFetchedToday
      ? JSON.parse(fs.readFileSync(outPath, 'utf8')).channelsFetchedAt
      : new Date().toISOString(),
    total:   matches.length,
    matches,
  };

  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`💾  Saved ${matches.length} matches → data/matches.json`);
}

fetchMatches();
