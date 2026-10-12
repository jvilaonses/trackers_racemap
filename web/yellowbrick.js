/*
 * YellowBrick tracker provider.
 *
 * Uses the public endpoints of the YB "pro" viewer (https://pro.yb.tl/<race>/),
 * which send `Access-Control-Allow-Origin: *`, so no proxy is needed:
 *   JSON  https://yb.tl/JSON/<race>/RaceSetup       race metadata, teams, divisions (tags), course
 *   JSON  https://yb.tl/JSON/<race>/leaderboard     per-division ranks, DTF, corrected times
 *   BIN   https://yb.tl/BIN/<race>/AllPositions3    full position history for every team
 *   BIN   https://yb.tl/BIN/<race>/LatestPositions3 latest positions only (cheap live polling)
 *
 * The XML API in tracker_docs/ (live.adventuretracking.com) now answers with a
 * 301 redirect and no CORS headers, so it is not usable from the browser.
 */
(function (root) {
  'use strict';

  const BASE = 'https://yb.tl';

  /*
   * Decode the YB binary position format ("*Positions3").
   *
   * Header: u8 flags, u32 reference time (unix seconds).
   *   flags & 1 altitude, & 2 DTF, & 4 lap, & 8 "pc" (percentage)
   * Then, until end of buffer, one block per team:
   *   u16 team id, u16 position count, then positions, newest first.
   * A position whose first byte has the high bit set is a delta against the
   * previous (newer) position; otherwise it is absolute.
   *   absolute: u32 time offset, i32 lat*1e5, i32 lon*1e5, [i16 alt], [i32 dtf, [u8 lap]], [i32 pc]
   *   delta:    u16 (0x8000 | seconds earlier), i16 dlat, i16 dlon, [i16 alt], [i16 ddtf, [u8 lap]], [i16 pc]
   * DTF is in metres.
   *
   * Returns { [teamId]: [{ at, lat, lon, dtf?, alt?, lap? }, ...] } sorted oldest first.
   */
  function decodePositions(buffer) {
    const view = new DataView(buffer);
    const result = {};
    if (view.byteLength < 5) return result;

    const flags = view.getUint8(0);
    const hasAlt = flags & 1;
    const hasDtf = flags & 2;
    const hasLap = flags & 4;
    const hasPc = flags & 8;
    const refTime = view.getUint32(1);
    let off = 5;

    while (off + 4 <= view.byteLength) {
      const teamId = view.getUint16(off);
      const count = view.getUint16(off + 2);
      off += 4;
      const moments = new Array(count);
      let prev = null;

      for (let i = 0; i < count; i++) {
        const m = {};
        if (view.getUint8(off) & 0x80) {
          const dt = view.getUint16(off) & 0x7fff;
          m.at = prev.at - dt;
          m.lat = prev.lat + view.getInt16(off + 2);
          m.lon = prev.lon + view.getInt16(off + 4);
          off += 6;
          if (hasAlt) { m.alt = view.getInt16(off); off += 2; }
          if (hasDtf) {
            m.dtf = prev.dtf + view.getInt16(off); off += 2;
            if (hasLap) { m.lap = view.getUint8(off); off += 1; }
          }
          if (hasPc) { off += 2; }
        } else {
          m.at = refTime + view.getUint32(off);
          m.lat = view.getInt32(off + 4);
          m.lon = view.getInt32(off + 8);
          off += 12;
          if (hasAlt) { m.alt = view.getInt16(off); off += 2; }
          if (hasDtf) {
            m.dtf = view.getInt32(off); off += 4;
            if (hasLap) { m.lap = view.getUint8(off); off += 1; }
          }
          if (hasPc) { off += 4; }
        }
        moments[i] = m;
        prev = m;
      }

      for (const m of moments) {
        m.lat /= 1e5;
        m.lon /= 1e5;
      }
      moments.reverse();
      result[teamId] = moments;
    }
    return result;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  }

  async function fetchBinary(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.arrayBuffer();
  }

  // Which team handicap field a division ("tag") uses.
  const HANDICAP_FIELD = { IRC: 'tcf1', TCF1: 'tcf1', TCF2: 'tcf2', TCF3: 'tcf3' };

  function parseNodes(nodes) {
    const parts = String(nodes).split(',').map(Number);
    const points = [];
    for (let i = 0; i + 1 < parts.length; i += 2) points.push([parts[i], parts[i + 1]]);
    return points;
  }

  /* Normalise RaceSetup into the app's provider-neutral event model. */
  function normaliseSetup(setup) {
    const divisions = (setup.tags || [])
      .filter((t) => t.lb !== false)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map((t) => ({
        id: t.id,
        name: t.name,
        handicap: t.handicap,
        tcfField: HANDICAP_FIELD[t.handicap] || null,
      }));

    const teams = (setup.teams || []).map((t) => ({
      id: t.id,
      name: t.name,
      sail: t.sail || '',
      model: t.model || '',
      skipper: t.captain || '',
      country: t.country || '',
      flag: t.flag || '',
      colour: '#' + (t.colour || '3388ff'),
      tcf: { tcf1: parseFloat(t.tcf1), tcf2: parseFloat(t.tcf2), tcf3: parseFloat(t.tcf3) },
      divisions: t.tags || [],
      start: t.start || null,
      finishedAt: t.finishedAt || null,
      status: t.status || '',
    }));

    const course = (setup.course && setup.course.nodes || []).map((n) => ({
      lat: n.lat, lon: n.lon, name: n.name || null,
    }));

    const overlays = (setup.poi && setup.poi.lines || []).map((l) => ({
      name: l.name,
      colour: '#' + (l.colour || 'ff0000'),
      polygon: !!l.polygon,
      points: parseNodes(l.nodes),
    }));

    return {
      title: setup.title || setup.url,
      start: setup.start || null,
      stop: setup.stop || null,
      raceStart: setup.pro && setup.pro.countdown || null,
      timezone: setup.tz || 'UTC',
      teams,
      divisions,
      course,
      overlays,
    };
  }

  /*
   * Leaderboard → { [divisionId]: { [teamId]: { rank, dtf, tcf, finished, status, finishAt, elapsed, corrected } } }
   * DTF is converted to nautical miles; times in seconds.
   */
  function normaliseLeaderboard(lb) {
    const out = {};
    for (const tag of (lb && lb.tags) || []) {
      const entries = {};
      for (const t of tag.teams || []) {
        entries[t.id] = {
          rank: t.rankR,
          dtf: typeof t.dtf === 'number' ? t.dtf / 1852 : null,
          tcf: parseFloat(t.tcf),
          finished: !!t.finished,
          started: !!t.started,
          status: t.status,
          finishAt: t.finishAt || t.eFinishR || null,
          elapsed: t.elapsed != null ? t.elapsed : t.eElapsedR,
          corrected: t.cElapsed != null ? t.cElapsed : t.cElapsedR,
          estimated: !t.finished,
        };
      }
      out[tag.id] = { type: tag.type, teams: entries };
    }
    return out;
  }

  const YellowBrick = {
    id: 'yellowbrick',
    name: 'YellowBrick',
    available: true,

    // Known events. Any other race key from a pro.yb.tl/<key>/ URL can be typed in.
    events: [
      { key: 'rmsr2026', name: 'Rolex Middle Sea Race 2026' },
      { key: 'rmsr2025', name: 'Rolex Middle Sea Race 2025 (replay)' },
    ],

    async loadEvent(key) {
      const setup = await fetchJson(`${BASE}/JSON/${key}/RaceSetup`);
      return normaliseSetup(setup);
    },

    async loadLeaderboard(key) {
      return normaliseLeaderboard(await fetchJson(`${BASE}/JSON/${key}/leaderboard`));
    },

    async loadAllPositions(key) {
      return decodePositions(await fetchBinary(`${BASE}/BIN/${key}/AllPositions3`));
    },

    async loadLatestPositions(key) {
      return decodePositions(await fetchBinary(`${BASE}/BIN/${key}/LatestPositions3`));
    },

    eventUrl(key) {
      return `https://pro.yb.tl/${key}/`;
    },
  };

  root.TrackerProviders = root.TrackerProviders || {};
  root.TrackerProviders.yellowbrick = YellowBrick;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decodePositions, normaliseSetup, normaliseLeaderboard, YellowBrick };
  }
})(typeof window !== 'undefined' ? window : globalThis);
