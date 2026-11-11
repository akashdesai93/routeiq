# RouteIQ diagrams

Made on Nov 11, 2026 with the open-source Archify skill (tt-a1i/archify 3.2, Apache-2.0),
run locally with Node. Open any `.html` file in a browser: it is self-contained, has a
light/dark switch, zoom, and its own Export menu (PNG/SVG). The `.png` next to each one is
a screenshot of the dark theme taken with local headless Chrome.

| # | Diagram | Open | Source | What it shows |
| --- | --- | --- | --- | --- |
| 1 | Roadmap | `01-roadmap.html` | `01-roadmap.workflow.json` | Everything done, in progress and next, in lanes: web prototype, signal data, native app, design, owner actions, Apple gates. |
| 2 | Web app architecture | `02-web-architecture.html` | `02-web-architecture.architecture.json` | The modules that exist today and what depends on what; `src/core` is the pure, portable part. |
| 3 | How a route gets chosen and switched | `03-route-choice.html` | `03-route-choice.sequence.json` | One check of a drive: position, Mapbox request, signal count, ranking, the reroute decision and its thresholds. |
| 4 | Signal data pipeline | `04-signal-pipeline.html` | `04-signal-pipeline.dataflow.json` | Geofabrik extracts to 0.1 degree tiles to the load chain to the 60 m / 30 m / 40 m count rules and coverage. |
| 5 | Target native architecture (PLANNED) | `05-native-target.html` | `05-native-target.architecture.json` | The planned SwiftUI app on Mapbox Navigation SDK v3 with RouteIQCore, tile pack, CI, TestFlight and CarPlay. |
| 6 | From here to driving it | `06-path-to-driving.html` | `06-path-to-driving.workflow.json` | Ordered steps to the first real commute test: build work, the owner's steps, and the two Apple gates. |

## Reading the status

- Diagrams 1, 5 and 6 use colour for status: green = built, amber = in progress now,
  cyan = planned, violet = owner action, rose = needs Apple. Each diagram has its own legend.
- Diagram 2 shows what is built (green), with the one in-progress part (live drive mode) in
  amber, data files and storage in orange, and outside services in grey.
- Numbers (thresholds, distances, tile counts) are read from `src/core/reroute.ts`,
  `src/core/signals.ts`, `README.md` and `PLAN.md` at commit `ff362ec`. Live drive mode was
  uncommitted work in progress when these were drawn.
- The diagrams are overviews written from reading the repo; they do not carry per-line
  source citations.

## Regenerating

From this folder, with the skill installed at `~/.claude/skills/archify`:

```
node ~/.claude/skills/archify/bin/archify.mjs finalize <type> <source.json> <output.html> --quality showcase --json
```

`<type>` is the middle part of the source file name (workflow, architecture, sequence,
dataflow). Setting `ARCHIFY_UPDATE_CHECK_DISABLED=1` keeps the run fully offline.
`*.delivery.json` and `receipts/` are the skill's own check receipts and can be deleted.
