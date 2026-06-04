const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.FOOTBALL_API_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

// Today date (YYYY-MM-DD)
const today = new Date().toISOString().split('T')[0];

async function fetchMatches() {
  if (!API_KEY) {
    console.error('FOOTBALL_API_KEY is missing');
    process.exit(1);
  }

  const url = `${BASE_URL}/fixtures?date=${today}`;

  let data;

  try {
    const res = await fetch(url, {
      headers: {
        "x-apisports-key": API_KEY
      }
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('API error:', res.status, text);
      process.exit(1);
    }

    data = await res.json();
  } catch (err) {
    console.error('Network error:', err.message);
    process.exit(1);
  }

  const rawMatches = data.response || [];

  // ❌ NO FILTER NEEDED (API already filters by date)
  const matches = rawMatches.map(item => {
    const fixture = item.fixture;
    const teams = item.teams;
    const goals = item.goals;
    const league = item.league;

    const status = fixture.status.short;

    // simple status label (no need for your old parseStatus)
    let statusLabel = status;

    if (status === 'FT') statusLabel = 'FT';
    if (status === 'HT') statusLabel = 'HT';
    if (status === 'NS') statusLabel = new Date(fixture.date).toTimeString().slice(0, 5);
    if (status === 'LIVE') statusLabel = 'LIVE';

    return {
      id: fixture.id,
      competition: league.name,
      competitionCode: league.code || league.id,

      home: teams.home.name,
      away: teams.away.name,

      homeLogo: teams.home.logo,
      awayLogo: teams.away.logo,

      utcDate: fixture.date,

      status: status,
      statusLabel: statusLabel,

      homeScore: goals.home,
      awayScore: goals.away
    };
  });

  const output = {
    date: today,
    fetchedAt: new Date().toISOString(),
    total: matches.length,
    matches: matches
  };

  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'matches.json');

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('Saved ' + matches.length + ' matches');
}

fetchMatches();
