/*
 * Trackers RaceMap: map + standings for sailing race trackers.
 *
 * Providers (yellowbrick.js, tractrac.js) register themselves on window.TrackerProviders
 * and expose a provider-neutral event model; this file handles the UI, live polling,
 * replay and the standings calculations.
 */
(function () {
  'use strict';

  const Providers = window.TrackerProviders;
  const PROVIDER_ORDER = ['yellowbrick', 'tractrac'];
  const DEFAULT_EVENT = { provider: 'yellowbrick', key: 'rmsr2026' };

  const LIVE_POLL_MS = 60 * 1000;        // latest positions + leaderboard
  const FULL_RELOAD_MS = 15 * 60 * 1000; // race setup + full position history
  const METRES_PER_NM = 1852;
  const ALL_BOATS = 'all';

  const state = {
    provider: null,
    key: null,
    event: null,
    positions: {},       // teamId -> [{at, lat, lon, dtf?}] oldest first
    leaderboard: null,   // divisionId -> {type, teams: {teamId: {...}}}
    divisionId: ALL_BOATS,
    time: null,          // displayed time, unix seconds
    followLive: true,
    playing: false,
    sortKey: 'lh',
    selectedTeamId: null,
    timers: [],
    loadToken: 0,
    requestedHash: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('event-form'),
    provider: $('provider-select'),
    event: $('event-select'),
    customLabel: $('custom-key-label'),
    customKey: $('custom-key'),
    modePill: $('mode-pill'),
    title: $('event-title'),
    link: $('event-link'),
    play: $('play-btn'),
    speed: $('speed-select'),
    slider: $('time-slider'),
    timeLabel: $('time-label'),
    live: $('live-btn'),
    division: $('division-select'),
    tracks: $('tracks-select'),
    message: $('message'),
    tbody: document.querySelector('#standings tbody'),
    headers: document.querySelectorAll('#standings th[data-sort]'),
    corrHeader: $('corr-header'),
    tmfHeader: $('tmf-header'),
    footnote: $('footnote'),
  };

  /* ====================================================================== */
  /* Map                                                                     */
  /* ====================================================================== */

  const map = L.map('map', { worldCopyJump: true }).setView([37.5, 14], 6);

  const baseLayers = {
    OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }),
    OpenTopoMap: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
        '<a href="http://viewfinderpanoramas.org">SRTM</a> | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> ' +
        '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    }),
  };
  const seaMarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: 'Seamarks &copy; <a href="https://www.openseamap.org">OpenSeaMap</a> contributors',
  });

  const courseLayer = L.layerGroup().addTo(map);
  const tracksLayer = L.layerGroup().addTo(map);
  const boatsLayer = L.layerGroup().addTo(map);

  baseLayers.OpenStreetMap.addTo(map);
  seaMarks.addTo(map);
  L.control.layers(baseLayers, {
    'OpenSeaMap seamarks': seaMarks,
    Course: courseLayer,
    Tracks: tracksLayer,
    Boats: boatsLayer,
  }).addTo(map);
  L.control.scale({ imperial: false, nautical: true }).addTo(map);

  const boatMarkers = {}; // teamId -> L.Marker
  const boatTracks = {};  // teamId -> L.Polyline

  function boatIcon(colour, heading, selected) {
    const size = selected ? 26 : 18;
    const stroke = selected ? '#000' : 'rgba(0,0,0,0.6)';
    const svg =
      `<svg width="${size}" height="${size}" viewBox="-10 -10 20 20">` +
      `<path d="M0,-9 L5,7 L0,4 L-5,7 Z" fill="${colour}" stroke="${stroke}" stroke-width="1.3" ` +
      `transform="rotate(${Math.round(heading || 0)})"/></svg>`;
    return L.divIcon({ className: 'boat-icon', html: svg, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function drawCourse(event) {
    courseLayer.clearLayers();
    if (event.course.length > 1) {
      L.polyline(event.course.map((n) => [n.lat, n.lon]), {
        color: '#d81b60', weight: 2, dashArray: '6 6', opacity: 0.8, interactive: false,
      }).addTo(courseLayer);
    }
    for (const n of event.course) {
      if (!n.name) continue;
      L.circleMarker([n.lat, n.lon], { radius: 4, color: '#d81b60', fillOpacity: 1 })
        .bindTooltip(n.name, { permanent: true, direction: 'right', className: 'course-label' })
        .addTo(courseLayer);
    }
    for (const o of event.overlays) {
      const opts = { color: o.colour, weight: 1.5, fillOpacity: 0.15 };
      const shape = o.polygon ? L.polygon(o.points, opts) : L.polyline(o.points, opts);
      shape.bindTooltip(o.name || '').addTo(courseLayer);
    }
  }

  function fitToEvent() {
    const points = [];
    for (const n of state.event.course) points.push([n.lat, n.lon]);
    if (!points.length) {
      for (const o of state.event.overlays) points.push(...o.points);
    }
    if (!points.length) {
      for (const id in state.positions) {
        const p = positionAt(state.positions[id], state.time);
        if (p) points.push([p.lat, p.lon]);
      }
    }
    if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.1));
  }

  /* ====================================================================== */
  /* Geometry + track helpers                                                */
  /* ====================================================================== */

  const toRad = (d) => d * Math.PI / 180;

  function distanceNm(a, b) {
    const R = 3440.065; // earth radius in nm
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearing(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /* Index of the last position at or before time t, or -1. */
  function indexAt(track, t) {
    let lo = 0, hi = track.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (track[mid].at <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }

  /*
   * Interpolated position at time t, with course/speed from the surrounding fixes.
   * Returns null before the first fix; holds the last fix after the final one.
   */
  function positionAt(track, t) {
    if (!track || !track.length) return null;
    const i = indexAt(track, t);
    if (i < 0) return null;
    const a = track[i];
    const b = track[i + 1];
    const prev = track[i - 1];
    let pos;
    if (b && b.at > a.at) {
      const f = (t - a.at) / (b.at - a.at);
      pos = {
        at: t,
        fixAt: a.at,
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        dtf: a.dtf != null && b.dtf != null ? a.dtf + (b.dtf - a.dtf) * f : a.dtf,
      };
    } else {
      pos = { at: a.at, fixAt: a.at, lat: a.lat, lon: a.lon, dtf: a.dtf };
    }
    const from = b ? a : prev;
    const to = b || a;
    if (from && to && to.at > from.at) {
      pos.cog = bearing(from, to);
      pos.sog = distanceNm(from, to) / ((to.at - from.at) / 3600);
    }
    return pos;
  }

  /* ====================================================================== */
  /* Standings                                                               */
  /* ====================================================================== */

  function currentDivision() {
    return state.event.divisions.find((d) => String(d.id) === String(state.divisionId)) || null;
  }

  function teamsInDivision(division) {
    if (!division) return state.event.teams;
    return state.event.teams.filter((t) => t.divisions.includes(division.id));
  }

  /*
   * TMF used for corrected time. A level-rating division (e.g. line honours) has no
   * TMF of its own, so we fall back to IRC (tcf1) and say so in the header.
   */
  function tmfField(division) {
    return (division && division.tcfField) || 'tcf1';
  }

  function tmfLabel(division) {
    if (division && division.tcfField) return division.handicap === 'TCF2' ? 'ORC' : division.handicap === 'TCF3' ? 'TCF3' : division.handicap;
    return 'IRC';
  }

  function atLiveEdge() {
    return state.time >= timeRange().max - 60;
  }

  /*
   * Standings at time t for the selected division.
   *  - DTF: interpolated from the tracker's own DTF values.
   *  - LH rank: finishers by finish time, then boats racing by DTF.
   *  - Corrected time: finishers use elapsed × TMF; boats still racing get an
   *    estimate, elapsed + DTF / average VMG so far, × TMF (shown in italics).
   *  - At the live edge, the provider's official leaderboard (if any) overrides
   *    DTF and the division's rank.
   */
  function computeStandings(t) {
    const division = currentDivision();
    const field = tmfField(division);
    const liveEdge = atLiveEdge();
    const official = liveEdge && state.leaderboard && division && state.leaderboard[division.id];

    const rows = teamsInDivision(division).map((team) => {
      const track = state.positions[team.id] || [];
      const pos = positionAt(track, t);
      const start = team.start || state.event.raceStart || state.event.start;
      const tmf = team.tcf[field];
      const lastFix = track.length ? track[track.length - 1].at : null;
      const retired = team.status === 'RETIRED' && (liveEdge || (lastFix != null && t >= lastFix));
      const finished = !!team.finishedAt && team.finishedAt <= t;
      const started = start != null && t >= start;

      let dtf = finished ? 0 : (pos && pos.dtf != null ? pos.dtf / METRES_PER_NM : null);
      let corrected = null;
      let estimated = false;

      if (finished) {
        corrected = (team.finishedAt - start) * tmf;
      } else if (started && !retired && dtf != null) {
        const startPos = positionAt(track, start) || track[0];
        const dtf0 = startPos && startPos.dtf != null ? startPos.dtf / METRES_PER_NM : null;
        const elapsed = t - start;
        if (dtf0 != null && elapsed > 0 && dtf0 > dtf) {
          const vmg = (dtf0 - dtf) / elapsed; // nm per second
          corrected = (elapsed + dtf / vmg) * tmf;
          estimated = true;
        }
      }

      let officialRank = null;
      const entry = official && official.teams[team.id];
      if (entry) {
        if (entry.dtf != null && !finished) dtf = entry.dtf;
        officialRank = entry.rank;
      }

      return { team, pos, dtf, tmf, finished, started, retired, corrected, estimated, officialRank };
    });

    rankBy(rows, 'lh', (a, b) => {
      if (a.finished && b.finished) return a.team.finishedAt - b.team.finishedAt;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return a.dtf - b.dtf;
    }, (r) => !r.retired && (r.finished || (r.started && r.dtf != null)));

    rankBy(rows, 'corr', (a, b) => a.corrected - b.corrected,
      (r) => !r.retired && r.corrected != null);

    // Official leaderboard rank replaces ours for the matching kind of ranking.
    if (official) {
      const kind = division.handicap === 'LEVEL' ? 'lh' : 'corr';
      for (const r of rows) {
        if (r.officialRank != null && !r.retired) {
          r[kind] = r.officialRank;
          if (kind === 'corr') r.estimated = !r.finished;
        }
      }
    }
    return rows;
  }

  function rankBy(rows, key, compare, eligible) {
    const ranked = rows.filter(eligible).sort(compare);
    rows.forEach((r) => { r[key] = null; });
    ranked.forEach((r, i) => { r[key] = i + 1; });
  }

  const SORTERS = {
    lh: (a, b) => nullsLast(a.lh, b.lh) || a.team.name.localeCompare(b.team.name),
    corr: (a, b) => nullsLast(a.corr, b.corr) || nullsLast(a.lh, b.lh),
    name: (a, b) => a.team.name.localeCompare(b.team.name),
    dtf: (a, b) => nullsLast(a.dtf, b.dtf) || nullsLast(a.lh, b.lh),
    tmf: (a, b) => nullsLast(b.tmf, a.tmf) || nullsLast(a.lh, b.lh),
  };

  function nullsLast(a, b) {
    const an = a == null || Number.isNaN(a);
    const bn = b == null || Number.isNaN(b);
    if (an || bn) return an === bn ? 0 : an ? 1 : -1;
    return a - b;
  }

  /* ====================================================================== */
  /* Rendering                                                               */
  /* ====================================================================== */

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function formatTime(t) {
    if (t == null) return '—';
    return new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
  }

  let lastTableRender = 0;

  function render(force) {
    if (!state.event) return;
    renderTimeline();
    renderBoats();
    const now = performance.now();
    if (force || !state.playing || now - lastTableRender > 500) {
      renderTable();
      lastTableRender = now;
    }
  }

  function renderTimeline() {
    const { min, max } = timeRange();
    const hasRange = max > min;
    els.slider.disabled = !hasRange;
    els.play.disabled = !hasRange;
    els.live.disabled = !hasRange;
    els.slider.min = min;
    els.slider.max = max;
    els.slider.value = state.time;
    els.timeLabel.textContent = formatTime(state.time);
    els.play.textContent = state.playing ? '❚❚' : '▶';
    const liveEvent = mode() !== 'finished';
    els.live.textContent = liveEvent ? 'Live' : 'End';
    els.live.classList.toggle('active', liveEvent && state.followLive);
  }

  function renderBoats() {
    const division = currentDivision();
    const visible = new Set(teamsInDivision(division).map((t) => t.id));
    const trackMode = els.tracks.value;

    for (const team of state.event.teams) {
      const track = state.positions[team.id];
      const pos = visible.has(team.id) ? positionAt(track, state.time) : null;
      let marker = boatMarkers[team.id];
      let line = boatTracks[team.id];

      if (!pos) {
        if (marker) boatsLayer.removeLayer(marker);
        if (line) tracksLayer.removeLayer(line);
        continue;
      }

      const selected = team.id === state.selectedTeamId;
      if (!marker) {
        marker = boatMarkers[team.id] = L.marker([pos.lat, pos.lon], { keyboard: false })
          .bindTooltip(team.name, { direction: 'top', offset: [0, -8] })
          .bindPopup('', { className: 'boat-popup' })
          .on('click', () => selectTeam(team.id, false))
          .on('popupopen', () => marker.setPopupContent(popupHtml(team)));
        marker._iconKey = null;
      }
      marker.setLatLng([pos.lat, pos.lon]);
      const iconKey = `${Math.round((pos.cog || 0) / 5)}|${selected}`;
      if (marker._iconKey !== iconKey) {
        marker.setIcon(boatIcon(team.colour, pos.cog, selected));
        marker.setZIndexOffset(selected ? 1000 : 0);
        marker._iconKey = iconKey;
      }
      if (!boatsLayer.hasLayer(marker)) boatsLayer.addLayer(marker);
      if (marker.isPopupOpen()) marker.setPopupContent(popupHtml(team));

      if (trackMode === 'none') {
        if (line) tracksLayer.removeLayer(line);
        continue;
      }
      const from = trackMode === 'full' ? -Infinity : state.time - Number(trackMode);
      const end = indexAt(track, state.time);
      const startIdx = Math.max(0, indexAt(track, from));
      const points = track.slice(startIdx, end + 1).map((m) => [m.lat, m.lon]);
      points.push([pos.lat, pos.lon]);
      if (!line) {
        line = boatTracks[team.id] = L.polyline(points, { color: team.colour, weight: 1.5, opacity: 0.8, interactive: false });
      } else {
        line.setLatLngs(points);
      }
      line.setStyle({ weight: selected ? 3 : 1.5 });
      if (!tracksLayer.hasLayer(line)) tracksLayer.addLayer(line);
    }
  }

  function popupHtml(team) {
    const pos = positionAt(state.positions[team.id], state.time);
    const rows = [
      ['Sail', team.sail],
      ['Model', team.model],
      ['Skipper', team.skipper],
      ['Country', team.country],
      ['TMF', `IRC ${fmt(team.tcf.tcf1, 3)} · ORC ${fmt(team.tcf.tcf2, 3)}`],
    ];
    if (pos) {
      if (pos.dtf != null) rows.push(['DTF', `${fmt(pos.dtf / METRES_PER_NM, 1)} nm`]);
      if (pos.sog != null) rows.push(['SOG / COG', `${fmt(pos.sog, 1)} kn / ${Math.round(pos.cog)}°`]);
      rows.push(['Last fix', formatTime(pos.fixAt)]);
    }
    if (team.finishedAt) rows.push(['Finished', formatTime(team.finishedAt)]);
    return `<h3>${escapeHtml(team.name)}</h3><table>` +
      rows.filter((r) => r[1]).map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`).join('') +
      '</table>';
  }

  function fmt(n, digits) {
    return n == null || Number.isNaN(n) ? '—' : n.toFixed(digits);
  }

  function renderTable() {
    const division = currentDivision();
    const rows = computeStandings(state.time).sort(SORTERS[state.sortKey]);
    const label = tmfLabel(division);
    els.tmfHeader.textContent = `TMF ${label}`;
    els.corrHeader.textContent = 'Corr.';
    els.corrHeader.title = `Rank on corrected time (${label} TMF)`;
    els.headers.forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sortKey));

    els.tbody.innerHTML = rows.map((r) => {
      const t = r.team;
      const cls = [t.id === state.selectedTeamId ? 'selected' : '', r.retired ? 'retired' : ''].join(' ');
      const lh = r.retired ? 'RET' : r.lh ?? '—';
      const corr = r.retired ? 'RET' : r.corr ?? '—';
      const dtf = r.finished ? 'FIN' : fmt(r.dtf, 1);
      const corrTitle = r.corrected != null
        ? `${r.estimated ? 'Estimated corrected' : 'Corrected'} time: ${formatDuration(r.corrected)}`
        : '';
      return `<tr data-team="${t.id}" class="${cls}">` +
        `<td class="rank">${lh}</td>` +
        `<td class="rank${r.estimated ? ' estimated' : ''}" title="${corrTitle}">${corr}</td>` +
        `<td><div class="boat-cell"><span class="swatch" style="background:${escapeHtml(t.colour)}"></span>` +
        `<span class="boat-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>` +
        `<span class="boat-sail">${escapeHtml(t.sail)}</span></div></td>` +
        `<td class="num">${dtf}</td>` +
        `<td class="num">${fmt(r.tmf, 3)}</td>` +
        '</tr>';
    }).join('');

    if (!rows.length) {
      els.tbody.innerHTML = '<tr><td colspan="5">No boats in this division yet.</td></tr>';
    }
  }

  function renderStatus() {
    const m = mode();
    const ev = state.event;
    els.modePill.hidden = false;
    els.modePill.className = `pill ${m}`;
    if (m === 'upcoming') {
      els.modePill.textContent = `STARTS IN ${formatDuration(ev.raceStart - Date.now() / 1000)}`;
    } else {
      els.modePill.textContent = m === 'live' ? 'LIVE' : 'FINISHED · REPLAY';
    }
    els.title.textContent = ev.title;
    const url = state.provider.eventUrl && state.provider.eventUrl(state.key);
    els.link.hidden = !url;
    if (url) els.link.href = url;

    els.footnote.textContent =
      'LH: line honours (finishers by time, then by DTF). Corr.: corrected-time rank; italics are estimates ' +
      '(elapsed + DTF ÷ average VMG, × TMF). At the latest time, ranks and DTF come from the official ' +
      `${state.provider.name} leaderboard when it is published.`;
  }

  function showMessage(text, isError) {
    els.message.hidden = !text;
    els.message.textContent = text || '';
    els.message.classList.toggle('error', !!isError);
  }

  /* ====================================================================== */
  /* Time + replay                                                           */
  /* ====================================================================== */

  function mode() {
    const now = Date.now() / 1000;
    const ev = state.event;
    if (ev.stop && now > ev.stop) return 'finished';
    if (ev.raceStart && now < ev.raceStart) return 'upcoming';
    return 'live';
  }

  function timeRange() {
    let min = Infinity, max = -Infinity;
    for (const id in state.positions) {
      const track = state.positions[id];
      if (!track.length) continue;
      min = Math.min(min, track[0].at);
      max = Math.max(max, track[track.length - 1].at);
    }
    const ev = state.event;
    if (ev.raceStart) {
      // Start the timeline shortly before the gun when we have pre-start data.
      if (min < ev.raceStart - 3600) min = ev.raceStart - 3600;
    }
    if (mode() !== 'finished' && max > -Infinity) max = Math.max(max, Math.floor(Date.now() / 1000));
    if (min === Infinity) {
      const now = Math.floor(Date.now() / 1000);
      return { min: now, max: now };
    }
    return { min, max };
  }

  function setTime(t, fromUser) {
    const { min, max } = timeRange();
    state.time = Math.min(max, Math.max(min, t));
    if (fromUser) state.followLive = state.time >= max - 60;
    render();
  }

  let lastFrame = null;

  function tick(ts) {
    if (!state.playing) return;
    if (lastFrame != null) {
      const dt = (ts - lastFrame) / 1000;
      const next = state.time + dt * Number(els.speed.value);
      const { max } = timeRange();
      if (next >= max) {
        state.playing = false;
        state.followLive = mode() !== 'finished';
        setTime(max);
        render(true);
        return;
      }
      setTime(next);
    }
    lastFrame = ts;
    requestAnimationFrame(tick);
  }

  function togglePlay() {
    state.playing = !state.playing;
    lastFrame = null;
    if (state.playing) {
      state.followLive = false;
      const { min, max } = timeRange();
      if (state.time >= max - 60) state.time = min; // replay from the beginning
      requestAnimationFrame(tick);
    }
    render(true);
  }

  /* ====================================================================== */
  /* Loading + live updates                                                  */
  /* ====================================================================== */

  function clearTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  function resetMap() {
    boatsLayer.clearLayers();
    tracksLayer.clearLayers();
    courseLayer.clearLayers();
    for (const id in boatMarkers) delete boatMarkers[id];
    for (const id in boatTracks) delete boatTracks[id];
  }

  async function loadEvent(providerId, key) {
    const provider = Providers[providerId];
    const token = ++state.loadToken;
    clearTimers();
    state.playing = false;
    showMessage('');

    if (!provider || !provider.available) {
      showMessage(provider ? provider.unavailableReason : `Unknown platform "${providerId}".`, true);
      return;
    }
    if (!key) {
      showMessage('Enter a race key.', true);
      return;
    }

    els.modePill.hidden = false;
    els.modePill.className = 'pill loading';
    els.modePill.textContent = 'LOADING…';
    els.title.textContent = key;
    state.requestedHash = `${providerId}/${encodeURIComponent(key)}`;
    location.hash = state.requestedHash;

    try {
      const [event, positions, leaderboard] = await Promise.all([
        provider.loadEvent(key),
        provider.loadAllPositions(key),
        provider.loadLeaderboard(key).catch(() => null),
      ]);
      if (token !== state.loadToken) return; // superseded by another load

      resetMap();
      Object.assign(state, {
        provider, key, event, positions, leaderboard,
        selectedTeamId: null, followLive: true,
      });
      populateDivisions();
      drawCourse(event);
      state.time = timeRange().max;
      renderStatus();
      render(true);
      fitToEvent();
      reportDataGaps();

      if (mode() !== 'finished') startLiveUpdates(token);
    } catch (err) {
      if (token !== state.loadToken) return;
      console.error(err);
      els.modePill.hidden = true;
      showMessage(`Could not load "${key}" from ${provider.name}: ${err.message}`, true);
    }
  }

  function reportDataGaps() {
    const ev = state.event;
    const tracked = Object.values(state.positions).filter((t) => t.length).length;
    if (!ev.teams.length) {
      showMessage('No boats have been published for this event yet.');
    } else if (!tracked) {
      showMessage(mode() === 'upcoming'
        ? `No positions yet. The race starts ${formatTime(ev.raceStart)}; this page checks for new data every minute.`
        : 'No positions have been published for this event.');
    } else {
      showMessage('');
    }
  }

  function startLiveUpdates(token) {
    const provider = state.provider;
    const key = state.key;

    state.timers.push(setInterval(async () => {
      try {
        const [latest, leaderboard] = await Promise.all([
          provider.loadLatestPositions(key),
          provider.loadLeaderboard(key).catch(() => state.leaderboard),
        ]);
        if (token !== state.loadToken) return;
        mergePositions(latest);
        state.leaderboard = leaderboard;
        afterUpdate();
      } catch (err) {
        console.warn('Live update failed', err);
      }
    }, LIVE_POLL_MS));

    state.timers.push(setInterval(async () => {
      try {
        const [event, positions] = await Promise.all([provider.loadEvent(key), provider.loadAllPositions(key)]);
        if (token !== state.loadToken) return;
        state.event = event;
        state.positions = positions;
        populateDivisions();
        drawCourse(event);
        afterUpdate();
      } catch (err) {
        console.warn('Full reload failed', err);
      }
    }, FULL_RELOAD_MS));

    // Keep the countdown / live clock moving between polls.
    state.timers.push(setInterval(() => {
      if (token !== state.loadToken) return;
      renderStatus();
      if (state.followLive && !state.playing) setTime(timeRange().max);
    }, 15 * 1000));
  }

  function mergePositions(latest) {
    for (const id in latest) {
      const incoming = latest[id];
      const track = state.positions[id] || (state.positions[id] = []);
      const lastAt = track.length ? track[track.length - 1].at : -Infinity;
      for (const m of incoming) if (m.at > lastAt) track.push(m);
    }
  }

  function afterUpdate() {
    if (state.followLive && !state.playing) state.time = timeRange().max;
    renderStatus();
    reportDataGaps();
    render(true);
  }

  /* ====================================================================== */
  /* Controls                                                                */
  /* ====================================================================== */

  const CUSTOM = '__custom__';

  function populateProviders() {
    els.provider.innerHTML = PROVIDER_ORDER.filter((id) => Providers[id]).map((id) => {
      const p = Providers[id];
      return `<option value="${id}">${escapeHtml(p.name)}${p.available ? '' : ' (not available yet)'}</option>`;
    }).join('');
  }

  function populateEvents(providerId, selectedKey) {
    const provider = Providers[providerId];
    const events = provider ? provider.events : [];
    const options = events.map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.name)}</option>`);
    if (provider && provider.available) options.push(`<option value="${CUSTOM}">Other race key…</option>`);
    els.event.innerHTML = options.join('');
    els.event.disabled = !options.length;
    els.form.querySelector('button').disabled = !provider || !provider.available;

    const known = events.some((e) => e.key === selectedKey);
    if (selectedKey && !known && provider && provider.available) {
      els.event.value = CUSTOM;
      els.customKey.value = selectedKey;
    } else if (selectedKey) {
      els.event.value = selectedKey;
    }
    els.customLabel.hidden = els.event.value !== CUSTOM;
    if (provider && !provider.available) showMessage(provider.unavailableReason, true);
  }

  function populateDivisions() {
    const divisions = state.event.divisions;
    const options = [`<option value="${ALL_BOATS}">All boats (${state.event.teams.length})</option>`]
      .concat(divisions.map((d) => {
        const count = state.event.teams.filter((t) => t.divisions.includes(d.id)).length;
        return `<option value="${d.id}">${escapeHtml(d.name)} (${count})</option>`;
      }));
    els.division.innerHTML = options.join('');
    if (!divisions.some((d) => String(d.id) === String(state.divisionId))) {
      // Default to the first division (usually line honours) when there is one.
      state.divisionId = divisions.length ? String(divisions[0].id) : ALL_BOATS;
    }
    els.division.value = state.divisionId;
  }

  function selectTeam(teamId, pan) {
    state.selectedTeamId = state.selectedTeamId === teamId && pan ? null : teamId;
    if (pan && state.selectedTeamId != null) {
      const pos = positionAt(state.positions[teamId], state.time);
      if (pos) map.panTo([pos.lat, pos.lon]);
    }
    render(true);
    const row = els.tbody.querySelector(`tr[data-team="${teamId}"]`);
    if (row && !pan) row.scrollIntoView({ block: 'nearest' });
  }

  function selectedKeyFromForm() {
    return els.event.value === CUSTOM ? els.customKey.value.trim() : els.event.value;
  }

  function parseHash() {
    const [provider, key] = location.hash.replace(/^#/, '').split('/');
    if (provider && Providers[provider]) return { provider, key: key ? decodeURIComponent(key) : null };
    return null;
  }

  els.provider.addEventListener('change', () => {
    showMessage('');
    populateEvents(els.provider.value, null);
  });

  els.event.addEventListener('change', () => {
    els.customLabel.hidden = els.event.value !== CUSTOM;
    if (els.event.value === CUSTOM) els.customKey.focus();
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadEvent(els.provider.value, selectedKeyFromForm());
  });

  els.slider.addEventListener('input', () => setTime(Number(els.slider.value), true));
  els.play.addEventListener('click', togglePlay);
  els.live.addEventListener('click', () => {
    state.playing = false;
    state.followLive = true;
    setTime(timeRange().max);
    render(true);
  });

  els.division.addEventListener('change', () => {
    state.divisionId = els.division.value;
    render(true);
  });
  els.tracks.addEventListener('change', () => render(true));

  els.headers.forEach((th) => th.addEventListener('click', () => {
    state.sortKey = th.dataset.sort;
    render(true);
  }));

  els.tbody.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-team]');
    if (row) selectTeam(Number(row.dataset.team), true);
  });

  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h && h.key && location.hash.slice(1) !== state.requestedHash) {
      els.provider.value = h.provider;
      populateEvents(h.provider, h.key);
      loadEvent(h.provider, h.key);
    }
  });

  /* ====================================================================== */
  /* Start                                                                   */
  /* ====================================================================== */

  populateProviders();
  const initial = parseHash() || DEFAULT_EVENT;
  els.provider.value = initial.provider;
  populateEvents(initial.provider, initial.key || (Providers[initial.provider].events[0] || {}).key);
  if (Providers[initial.provider].available) loadEvent(initial.provider, selectedKeyFromForm());
})();
