# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Phase 0 is implemented; goals and scope live in `project_requirements.md`. No build step and no dependencies.

- `npm start`: zero-dependency static server (`index.js`) for `web/` on http://localhost:8080/ (`PORT` to override).
- `npm test`: `node --test` unit tests in `test/` (YellowBrick decoder and normalisation).
- `web/trackers.html|.css|.js` is the app; providers register on `window.TrackerProviders` (`web/yellowbrick.js`, `web/tractrac.js` stub) and expose a provider-neutral event model. Deep link: `trackers.html#yellowbrick/<raceKey>`.

## What is being built

A single-page, map-based web app that shows live and replayed positions from sailing race trackers and runs calculations on that data.

- The main page is `trackers.html`, with companion `.css` and `.js` files, in `web/`.
- Map: Leaflet, with OpenStreetMap, OpenTopoMap and OpenSeaMap (seamark overlay) layers.
- The user picks an event from a tracker system (YellowBrick or TracTrac). Data updates live for ongoing races and plays back for finished ones.
- First target event: Rolex Middle Sea Race 2026 on YellowBrick (https://pro.yb.tl/rmsr2026/), starting 17 October 2026.

## Tracker data sources (`tracker_docs/`)

**YellowBrick**: the XML API in `Yellowbrick XML API Notes.pdf` (`live.adventuretracking.com/xml/...`) is obsolete: it returns a 301 and sends no CORS headers. The app instead uses the endpoints behind the pro viewer, which send `Access-Control-Allow-Origin: *`, so no proxy is needed:
- `https://yb.tl/JSON/<race>/RaceSetup`: title, `start`/`stop`, `pro.countdown` (first gun), `teams` (`tcf1` IRC, `tcf2` ORC, `tcf3`, `tags`, `start`, `finishedAt`, `status`), `tags` (divisions, `handicap` LEVEL/IRC/TCF2/TCF3), `course.nodes`, `poi.lines`.
- `https://yb.tl/JSON/<race>/leaderboard`: per division (tag id), each team has `rankR`, `dtf` (metres), `tcf`, `finished`, elapsed and corrected times (estimated `*R` fields for boats still racing). Teams are referenced by id only.
- `https://yb.tl/BIN/<race>/AllPositions3` (full history) and `LatestPositions3` (latest only): a binary format decoded by `decodePositions` in `web/yellowbrick.js`. DTF there is in metres.

**TracTrac** (`TracTrac_Event.pdf`): this is a pricing brochure, not API documentation. API access comes only with their "Gold" pack, and the API is otherwise undocumented here.
