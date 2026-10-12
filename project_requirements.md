# Trackers RaceMap project requirements

## Project goal
The objective of this project is to develop a map based single page web page to display several sailing race boat tracker data, and do some calculations with that data.
We require to use Leaflet as a map engine, with OpenStreetMap, OpenTopoMap, and OpenSeaMap layers as a base map.
We anticipate sailboat race tracker systems to be implemented to be YellowBrick tracker, and the TracTrac tracker.
The yellow brick offers an API shortly documented in the "tracker_docs" folder. 
The yellow brick documentation may be a bit old, so it needs to br tested and validated.
At this stage, I do not know much on API for the TracTrac system.

## First steps (development phase 0)
- Build the basic html structure. Main web page to be called trackers.html, with its .css and .js companion files.
- User can choose an event in a tracking system (YellowBrick or TracTrac)
- The data from the event's to be updated live for ongoing events / races, or also in replay mode for races that have ended.
- We want to start, as an example, with the upcoming Rolex Middle Sea Race, serviced by YellowBrick (https://pro.yb.tl/rmsr2026/), scheduled to start 17 October.
- User interface to choose the tracking platform and event.
- Display participants basic data: names, distance to finish (DTF), rank (line honors and corrected time), and TMF (time multiplying factor for corrected time calculation)

## Development phase 1
To be defined, depending on the outcome of phase 0.