// Championship: multi-round season with points, driver + team standings, persisted in localStorage.
import { POINTS, TEAMS, DRIVERS } from './Roster.js';
import { CIRCUITS } from '../track/circuits/index.js';

const KEY = 'apexgp.championship.v1';

export class Championship {
  constructor() { this.state = null; this.load(); }
  load() { try { const r = localStorage.getItem(KEY); this.state = r ? JSON.parse(r) : null; } catch (e) { this.state = null; } }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ } }
  get active() { return !!this.state && !this.state.finished; }
  get round() { return this.state ? this.state.round : 0; }
  get calendar() { return this.state ? this.state.calendar : []; }
  get currentTrack() { return this.state && this.calendar[this.state.round]; }

  start(opts) {
    const calendar = opts.calendar && opts.calendar.length ? opts.calendar : CIRCUITS.map((c) => c.id);
    this.state = { calendar, round: 0, laps: opts.laps || 3, difficulty: opts.difficulty || 'pro', team: opts.team || 0, aiCount: opts.aiCount ?? 19, weather: opts.weather || 'dynamic', drivers: {}, teams: {}, results: [], finished: false };
    this.save();
  }
  abandon() { this.state = null; try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }

  /** feed the finished race classification (rows from RaceManager.buildClassification) */
  record(rows) {
    const s = this.state; if (!s) return;
    const res = [];
    rows.forEach((r) => {
      const key = r.driver.isPlayer ? 'YOU' : r.name;
      const teamId = r.team.id;
      const pts = r.status === 'dnf' ? 0 : POINTS[r.pos - 1] || 0;
      const dd = (s.drivers[key] = s.drivers[key] || { name: r.driver.isPlayer ? 'You' : r.name, team: teamId, points: 0, wins: 0, podiums: 0, isPlayer: !!r.driver.isPlayer });
      dd.points += pts; if (r.pos === 1 && r.status !== 'dnf') dd.wins++; if (r.pos <= 3 && r.status !== 'dnf') dd.podiums++;
      const tt = (s.teams[teamId] = s.teams[teamId] || { name: r.team.name, color: r.team.color, points: 0 });
      tt.points += pts;
      res.push({ key, pos: r.pos, pts });
    });
    s.results.push({ track: s.calendar[s.round], res });
    s.round++;
    if (s.round >= s.calendar.length) s.finished = true;
    this.save();
  }
  driverStandings() {
    const s = this.state; if (!s) return [];
    return Object.values(s.drivers).sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
  }
  teamStandings() {
    const s = this.state; if (!s) return [];
    return Object.values(s.teams).sort((a, b) => b.points - a.points);
  }
}
