const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const API_KEY  = process.env.FOOTBALL_API_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';
const today    = new Date().toISOString().split('T')[0];

// ─── STATIC CHANNELS BY COMPETITION ID ────────────────────
// Keyed by API league.id — sources verified June 2026:
//
// • Botola Pro       → Arryadia ONLY (exclusive Moroccan league broadcaster)
// • Arryadia         → ONLY broadcasts: Botola Pro, Morocco NT matches (WC, AFCON, qualifiers)
//                      Does NOT broadcast club competitions from other countries
// • Al Aoula / 2M   → Never broadcast any football
// • World Cup 2026   → beIN (all 104) + Arryadia (only Morocco's group games via SNRT deal)
//                      For the data we show ALL WC matches as beIN+TOD, and add Arryadia
//                      only as a note since we can't filter per-match here
// • Saudi Pro League → Thmanyah + Shahid (SSC closed Oct 2025)
// • Premier League   → beIN exclusive MENA until 2028

const CHANNELS_BY_ID = {
  // ── World Cup 2026 ───────────────────────────────────────
  // beIN: all 104 games. Arryadia: only Morocco's 3 group games (sub-license from beIN)
  // We show both since users may be watching Morocco specifically
  1:   ['beIN Sports', 'Arryadia', 'TOD'],

  // ── UEFA competitions ────────────────────────────────────
  2:   ['beIN Sports', 'TOD'],   // Champions League
  3:   ['beIN Sports', 'TOD'],   // Europa League
  848: ['beIN Sports', 'TOD'],   // Conference League

  // ── Top 5 European Leagues ───────────────────────────────
  39:  ['beIN Sports', 'TOD'],            // Premier League — beIN exclusive MENA to 2028
  140: ['beIN Sports', 'TOD'],            // La Liga
  135: ['beIN Sports', 'TOD'],            // Serie A
  78:  ['beIN Sports', 'TOD'],            // Bundesliga
  61:  ['beIN Sports', 'Canal+', 'TOD'], // Ligue 1

  // ── Morocco ──────────────────────────────────────────────
  200: ['Arryadia'],   // Botola Pro — Arryadia exclusive, beIN has zero rights
  201: ['Arryadia'],   // Botola 2

  // ── Africa / CAF / AFCON ─────────────────────────────────
  // Arryadia only when Morocco is playing — but since we can't filter per-match,
  // we show beIN+TOD for the competition in general
  6:   ['beIN Sports', 'TOD'],   // WC Qualifying Africa
  7:   ['beIN Sports', 'TOD'],   // AFCON
  29:  ['beIN Sports', 'TOD'],   // AFCON Qualification
  20:  ['beIN Sports', 'TOD'],   // CAF Champions League
  21:  ['beIN Sports', 'TOD'],   // CAF Confederation Cup

  // ── Saudi Arabia ─────────────────────────────────────────
  // SSC closed Oct 2025. Rights: Thmanyah (free satellite) + Shahid (streaming)
  307: ['Thmanyah', 'Shahid'],   // Saudi Pro League (Roshn League)
  682: ['Thmanyah', 'Shahid'],   // King's Cup
  348: ['Thmanyah'],             // Saudi First Division (Yelo League)

  // ── Other Arab Leagues ───────────────────────────────────
  233: ['beIN Sports', 'On Sport', 'TOD'],         // Egyptian Premier League
  435: ['beIN Sports', 'Abu Dhabi Sports', 'TOD'], // UAE Pro League
  370: ['beIN Sports', 'Al Kass', 'TOD'],          // Qatar Stars League
  383: ['beIN Sports', 'TOD'],                     // Tunisian Ligue Pro
  197: ['beIN Sports', 'TOD'],                     // Algerian Ligue Pro
  318: ['beIN Sports', 'TOD'],                     // Jordanian Pro League
  387: ['beIN Sports', 'TOD'],                     // Iraqi Premier League
  390: ['beIN Sports', 'TOD'],                     // Lebanese Premier League
  330: ['beIN Sports', 'Al Kass', 'TOD'],          // Kuwait Premier League
  397: ['beIN Sports', 'TOD'],                     // Bahrain Premier League
  399: ['beIN Sports', 'TOD'],                     // Oman Pro League

  // ── International ────────────────────────────────────────
  10:  ['beIN Sports', 'TOD'],                   // Friendlies (international)
  5:   ['beIN Sports', 'TOD'],                   // UEFA Nations League
  15:  ['beIN Sports', 'TOD'],                   // FIFA Club World Cup
  552: ['beIN Sports', 'Al Jazeera', 'TOD'],     // Arab Cup

  // ── France domestic ──────────────────────────────────────
  66:  ['beIN Sports', 'France TV', 'TOD'],      // Coupe de France
  62:  ['beIN Sports', 'Canal+', 'TOD'],         // Ligue 2
};

// ─── NAME-BASED FALLBACK ─────────────────────────────────
const CHANNELS_BY_NAME = [
  { match: 'world cup',        channels: ['beIN Sports', 'Arryadia', 'TOD'] },
  { match: 'champions league', channels: ['beIN Sports', 'TOD'] },
  { match: 'europa league',    channels: ['beIN Sports', 'TOD'] },
  { match: 'conference leag',  channels: ['beIN Sports', 'TOD'] },
  { match: 'premier league',   channels: ['beIN Sports', 'TOD'] },
  { match: 'ligue 1',          channels: ['beIN Sports', 'Canal+', 'TOD'] },
  { match: 'la liga',          channels: ['beIN Sports', 'TOD'] },
  { match: 'serie a',          channels: ['beIN Sports', 'TOD'] },
  { match: 'bundesliga',       channels: ['beIN Sports', 'TOD'] },
  { match: 'botola',           channels: ['Arryadia'] },
  { match: 'saudi pro',        channels: ['Thmanyah', 'Shahid'] },
  { match: 'king cup',         channels: ['Thmanyah', 'Shahid'] },
  { match: 'roshn',            channels: ['Thmanyah', 'Shahid'] },
  { match: 'afcon',            channels: ['beIN Sports', 'TOD'] },
  { match: 'africa cup',       channels: ['beIN Sports', 'TOD'] },
  { match: 'arab cup',         channels: ['beIN Sports', 'Al Jazeera', 'TOD'] },
  { match: 'caf ',             channels: ['beIN Sports', 'TOD'] },
  { match: 'nations league',   channels: ['beIN Sports', 'TOD'] },
  { match: 'friendly',         channels: ['beIN Sports', 'TOD'] },
  { match: 'qualifying',       channels: ['beIN Sports', 'TOD'] },
];

function getChannels(competitionId, competitionName) {
  // 1. Try exact ID match first (most reliable)
  if (CHANNELS_BY_ID[competitionId]) {
    return CHANNELS_BY_ID[competitionId];
  }
  // 2. Try name substring match
  const lower = (competitionName || '').toLowerCase();
  for (const entry of CHANNELS_BY_NAME) {
    if (lower.includes(entry.match)) return entry.channels;
  }
  // 3. No match — return empty
  return [];
}

// ─── STATUS PARSER ────────────────────────────────────────
function parseStatus(fixture, goals) {
  const s = fixture.status.short;
  if (s === 'FT' || s === 'AET' || s === 'PEN')
    return { type: 'finished',  label: 'FT',   homeScore: goals.home, awayScore: goals.away };
  if (s === 'HT')
    return { type: 'halftime',  label: 'HT',   homeScore: goals.home, awayScore: goals.away };
  if (['1H','2H','ET','LIVE'].includes(s))
    return { type: 'live',      label: 'LIVE', homeScore: goals.home, awayScore: goals.away };
  if (s === 'NS') {
    const d = new Date(fixture.date);
    const hh = String(d.getUTCHours()).padStart(2,'0');
    const mm = String(d.getUTCMinutes()).padStart(2,'0');
    return { type: 'scheduled', label: `${hh}:${mm}`, homeScore: null, awayScore: null };
  }
  if (s === 'PST')  return { type: 'postponed', label: 'PPD',  homeScore: null, awayScore: null };
  if (s === 'CANC') return { type: 'cancelled', label: 'CANC', homeScore: null, awayScore: null };
  return { type: 'unknown', label: s, homeScore: null, awayScore: null };
}

// ─── MAIN ─────────────────────────────────────────────────
async function fetchMatches() {
  if (!API_KEY) { console.error('❌  FOOTBALL_API_KEY not set.'); process.exit(1); }

  console.log(`📅  Fetching matches for ${today}…`);

  // ── Step 1: API call ──────────────────────────────────
  let data;
  try {
    const res = await fetch(`${BASE_URL}/fixtures?date=${today}`, {
      headers: { 'x-apisports-key': API_KEY },
    });
    if (!res.ok) { console.error(`❌  API ${res.status}:`, await res.text()); process.exit(1); }
    data = await res.json();
  } catch (err) { console.error('❌  Network:', err.message); process.exit(1); }

  const rawMatches = data.response || [];
  console.log(`✅  ${rawMatches.length} matches from API`);

  // ── Step 2: Build + assign channels in one pass ───────
  // No scraping, no caching complexity — channels come from the
  // static rights map which is always correct and instant.
  const matches = rawMatches
    .map(item => {
      const { fixture, teams, goals, league } = item;
      const status = parseStatus(fixture, goals);
      const channels = getChannels(league.id, league.name);
      return {
        id:              fixture.id,
        competition:     league.name || 'Unknown',
        competitionFlag: '⚽',
        competitionCode: league.id,
        home:            teams.home.name || 'TBD',
        away:            teams.away.name || 'TBD',
        homeLogo:        teams.home.logo  || null,
        awayLogo:        teams.away.logo  || null,
        utcDate:         fixture.date,
        status:          status.type,
        statusLabel:     status.label,
        homeScore:       status.homeScore,
        awayScore:       status.awayScore,
        channels,
      };
    })
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  const withChannels = matches.filter(m => m.channels.length > 0).length;
  console.log(`📺  ${withChannels}/${matches.length} matches have channel data`);

  // ── Step 3: Write output ──────────────────────────────
  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'matches.json');
  const output = {
    date:      today,
    fetchedAt: new Date().toISOString(),
    total:     matches.length,
    matches,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`💾  Saved ${matches.length} matches → data/matches.json`);
}

fetchMatches();
