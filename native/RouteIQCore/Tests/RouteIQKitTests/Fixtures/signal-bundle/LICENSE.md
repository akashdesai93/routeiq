# Traffic signal tiles: OpenStreetMap

The files in this folder hold map data from OpenStreetMap: the positions of nodes tagged
`highway=traffic_signals`, one file per 0.1 degree tile that has any, and an `index.json` that
says which tiles are covered. They were built from regional extracts of OpenStreetMap
(extract by Geofabrik, https://download.geofabrik.de/).

© OpenStreetMap contributors

The data is available under the Open Database License (ODbL) 1.0:
https://www.openstreetmap.org/copyright
https://opendatacommons.org/licenses/odbl/1-0/

You are free to copy, distribute, transmit and adapt this data, as long as you credit
OpenStreetMap and its contributors. If you alter or build upon the data, you may distribute the
result only under the same license.

Nothing from any other source is in this folder. Written by scripts/build-signal-tiles.mjs.
