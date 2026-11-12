// The stub server of the simulator drive: it stands in for Mapbox on the build
// machine, so the run needs no token and no secret.
//
// - Directions: answered from the made-up road network of the e2e scenarios
//   (e2e/world/roads.ts), for the trip the app opens with. Free-flowing
//   traffic, so nothing is ever faster: the only route change in a run is the
//   one after the wrong turn.
// - The map style: a drawing of that road network (grey lines on a plain
//   background, no labels), so the map is not blank without a token.
// - /sim/report: where the page script (page.js) says what the screen shows,
//   and picks up the driver script's commands.
//
// Listens on 127.0.0.1 only. Node 24 runs the TypeScript imports as they are.
import http from 'node:http'
import { FREE_FLOW, World } from '../../../e2e/world/roads.ts'
import { DEFAULT_TRIP } from '../../../src/core/testPoints.ts'

export const TRIP = { origin: DEFAULT_TRIP.origin.position, destination: DEFAULT_TRIP.destination.position }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/** The map style: the made-up roads, drawn. Nothing in it needs a tile, a font or a token. */
export function styleOf(world) {
  const road = (name) => ({ type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates: world.cornersOf(name) } })
  return {
    version: 8,
    name: 'RouteIQ simulator drive: made-up roads',
    sources: { roads: { type: 'geojson', data: { type: 'FeatureCollection', features: ['B', 'C', 'A'].map(road) } } },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': '#eef1ec' } },
      { id: 'road-edge', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#b8beb4', 'line-width': 9 } },
      { id: 'road', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6 } },
    ],
  }
}

/**
 * Starts the stub. `stub.reports` is every report of the page, oldest first;
 * `stub.directions` every route request and what it was answered with;
 * `stub.send(cmd, arg)` hands the page a command and resolves with its result.
 */
export async function startStub({ port = 8521, log = () => {} } = {}) {
  const world = new World(TRIP.origin, TRIP.destination)
  const reports = []
  const directions = []
  const unexpected = []
  const queue = []
  const waiting = new Map()
  let commandId = 0
  let requestNumber = 0

  const json = (res, status, body) => {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function answerDirections(url, res) {
    const points = decodeURIComponent(url.pathname.split('/').at(-1))
      .split(';')
      .map((c) => c.split(',').map(Number))
    const from = points[0]
    const to = points.at(-1)
    const bad = points.length < 2 || points.some((p) => p.length !== 2 || !p.every(Number.isFinite))
    if (bad) return json(res, 422, { code: 'InvalidInput', message: 'Coordinates are invalid' })
    if (Math.abs(to[0] - TRIP.destination[0]) > 1e-4 || Math.abs(to[1] - TRIP.destination[1]) > 1e-4) {
      // The stub knows one trip. Anything else gets Mapbox's "no route".
      directions.push({ n: null, atMs: Date.now(), kind: 'other-trip', offered: [] })
      return json(res, 200, { code: 'NoRoute', message: 'The simulator drive only knows the trip the app opens with', routes: [] })
    }
    const at = world.frameOf(from)
    const where = { share: Math.round(at.f * 1000) / 1000, sideM: Math.round(at.side) }
    // A plan-screen side-street probe: one via and no bearings (as in e2e/harness.ts).
    if (points.length === 3 && url.searchParams.get('waypoints') === '0;2' && !url.searchParams.has('bearings')) {
      const viaRadius = Number(url.searchParams.get('radiuses')?.split(';')[1])
      const probe = world.through(from, points[1], FREE_FLOW, requestNumber, Number.isFinite(viaRadius) ? viaRadius : undefined)
      directions.push({ n: requestNumber, atMs: Date.now(), kind: 'probe', offered: probe.road === null ? [] : [probe.road], where })
      return json(res, 200, probe.answer)
    }
    // The drive's own check of the route being driven: through vias, with the car's heading.
    if (points.length > 2) {
      const path = world.pathThrough(from, points.slice(1, -1), FREE_FLOW, requestNumber + 1)
      if (path !== null) {
        requestNumber++
        directions.push({ n: requestNumber, atMs: Date.now(), kind: 'path-check', offered: [path.road], where })
        return json(res, 200, path.answer)
      }
    }
    requestNumber++
    const answer = world.directions(from, FREE_FLOW, requestNumber)
    const offered = world.lastOffered.map((r) => r.name)
    const offRoute = offered[0] === 'off-route'
    directions.push({
      n: requestNumber,
      atMs: Date.now(),
      kind: offRoute ? 'off-route' : 'routes',
      offered,
      where,
      // What a driver who follows the app drives next: the driver script reads this after a wrong turn.
      corners: world.lastOffered[0]?.corners ?? null,
    })
    log(`route request ${requestNumber}: ${offered.join(', ')} (from ${Math.round(at.f * 100)} % of the way, ${Math.round(at.side)} m to the side)`)
    return json(res, 200, answer)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    if (req.method === 'POST' && url.pathname === '/sim/report') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        let report
        try {
          report = JSON.parse(body)
        } catch {
          return json(res, 400, { error: 'not JSON' })
        }
        report.receivedAtMs = Date.now()
        reports.push(report)
        for (const result of report.results ?? []) {
          waiting.get(result.id)?.(result)
          waiting.delete(result.id)
        }
        json(res, 200, { commands: queue.splice(0) })
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/directions/v5/mapbox/driving-traffic/')) return answerDirections(url, res)
    if (req.method === 'GET' && url.pathname.startsWith('/styles/v1/')) return json(res, 200, styleOf(world))
    if (req.method === 'GET' && url.pathname === '/sim/state') {
      return json(res, 200, { reports: reports.length, latest: reports.at(-1) ?? null, directions: directions.map(({ corners: _c, ...rest }) => rest), unexpected })
    }
    if (unexpected.length < 100) unexpected.push(`${req.method} ${url.pathname}`)
    return json(res, 404, { message: 'Not Found' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  return {
    port,
    world,
    reports,
    directions,
    unexpected,
    latest: () => reports.at(-1) ?? null,
    /** Hands the page a command with its next report. Resolves with `{ ok, value }`, or `{ ok: false, value: 'no answer' }` after `timeoutMs`. */
    send(cmd, arg = {}, timeoutMs = 10_000) {
      const id = ++commandId
      queue.push({ id, cmd, arg })
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          const at = queue.findIndex((c) => c.id === id)
          if (at !== -1) queue.splice(at, 1)
          resolve({ id, ok: false, value: 'no answer' })
        }, timeoutMs)
        waiting.set(id, (result) => {
          clearTimeout(timer)
          resolve(result)
        })
      })
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
