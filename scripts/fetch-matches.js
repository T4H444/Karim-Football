const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.FOOTBALL_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

// Today's date in YYYY-MM-DD format (UTC)
const today = new Date().toISOString().split('T')[0];

// Competition display names
const COMPETITION_META = {
  PL:  { name: 'Premier League', flag: '' },
  CL:  { name: 'Champions League', flag: '' },
  BL1: { name: 'Bundesliga', flag: '' },
  PD:  { name: 'La Liga', flag: '' },
  FL1: { name: 'Ligue 1', flag: '' },
  SA:  { name: 'Serie A', flag: '' },
  WC:  { name: 'FIFA World Cup', flag: '' },
  EC:  { name: 'Euro Championship', flag: '' },
  ELC: { name: 'Championship', flag: '' },
  DED: { name: 'Eredivisie', flag: '' },
  BSA: { name: 'Brasileirao Serie A', flag: '' },
  PPL: { name: 'Primeira Liga', flag: '' }
};

function parseStatus(match) {
  const s = match.status;
  const score = match.score;

  if (s === 'FINISHED') {
    return {
      label: 'FT',
      type: 'finished',
      homeScore: score?.fullTime?.home ?? null,
      awayScore: score?.fullTime?.away ?? null
    };
  }

  if (s === 'IN_PLAY') {
    return {
      label: 'LIVE',
      type: 'live',
      homeScore: score?.fullTime?.home ?? null,
      awayScore: score?.fullTime?.away ?? null
    };
  }

  if (s === 'PAUSED') {
    return {
      label: 'HT',
      type: 'halftime',
      homeScore: score?.halfTime?.home ?? null,
      awayScore: score?.halfTime?.away ?? null
    };
  }

  if (s === 'TIMED' || s === 'SCHEDULED') {
    const utcDate = new Date(match.utcDate);
    const hours = String(utcDate.getUTCHours()).padStart(2, '0');
    const mins = String(utcDate.getUTCMinutes()).padStart(2, '0');

    return {
      label: hours + ':' + mins,
      type: 'scheduled',
      homeScore: null,
      awayScore: null
    };
  }

  if (s === 'POSTPONED') {
    return { label: 'PPD', type: 'postponed', homeScore: null, awayScore: null };
  }

  if (s === 'CANCELLED') {
    return { label: 'CANC', type: 'cancelled', homeScore: null, awayScore: null };
  }

  return { label: s, type: 'unknown', homeScore: null, awayScore: null };
}

async function fetchMatches() {
  if (!API_KEY) {
    console.error('FOOTBALL_API_KEY is missing');
    process.exit(1);
  }

  const url = BASE_URL + '/matches?dateFrom=' + today + '&dateTo=' + today;

  let data;

  try {
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': API_KEY }
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

  const rawMatches = data.matches || [];

  const matches = rawMatches.map(match => {
    const compCode = match.competition?.code || 'UNKNOWN';
    const meta = COMPETITION_META[compCode] || {
      name: match.competition?.name || compCode,
      flag: ''
    };

    const status = parseStatus(match);

    return {
      id: match.id,
      competition: meta.name,
      competitionCode: compCode,
      home: match.homeTeam?.name || 'TBD',
      away: match.awayTeam?.name || 'TBD',
      homeLogo: match.homeTeam?.crest || null,
      awayLogo: match.awayTeam?.crest || null,
      utcDate: match.utcDate,
      status: status.type,
      statusLabel: status.label,
      homeScore: status.homeScore,
      awayScore: status.awayScore
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
