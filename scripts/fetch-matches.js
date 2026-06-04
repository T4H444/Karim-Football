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

  const matches = rawMatches.map(item => {
    const fixture = item.fixture;
    const teams = item.teams;
    const goals = item.goals;
    const league = item.league;

    const statusShort = fixture.status.short; // FT, HT, NS, 1H, 2H...

    // ---- STATUS NORMALIZATION ----
    let status = 'scheduled';
    let statusLabel = '';

    if (statusShort === 'FT') {
      status = 'finished';
      statusLabel = 'FT';
    } 
    else if (statusShort === 'HT') {
      status = 'halftime';
      statusLabel = 'HT';
    } 
    else if (statusShort === 'NS') {
      status = 'scheduled';
      const d = new Date(fixture.date);
      statusLabel = d.toISOString().slice(11, 16); // HH:MM
    } 
    else if (['1H', '2H', 'LIVE'].includes(statusShort)) {
      status = 'live';
      statusLabel = 'LIVE';
    } 
    else if (statusShort === 'PST') {
      status = 'postponed';
      statusLabel = 'PPD';
    } 
    else if (statusShort === 'CANC') {
      status = 'cancelled';
      statusLabel = 'CANC';
    } 
    else {
      status = 'unknown';
      statusLabel = statusShort;
    }

    return {
      id: fixture.id,

      // FIXED: proper league mapping
      competition: league.name || 'Unknown',
      competitionCode: league.id || league.name || 'UNKNOWN',

      home: teams.home.name || 'TBD',
      away: teams.away.name || 'TBD',

      homeLogo: teams.home.logo || null,
      awayLogo: teams.away.logo || null,

      utcDate: fixture.date,

      status,
      statusLabel,

      homeScore: goals.home,
      awayScore: goals.away
    };
  });

  const output = {
    date: today,
    fetchedAt: new Date().toISOString(),
    total: matches.length,
    matches
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
