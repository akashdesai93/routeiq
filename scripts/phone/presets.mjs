// The streets the simulated drives follow: Uptown Charlotte (Trade and Tryon, Independence
// Square) to SouthPark Mall, both public landmarks. Nothing here is anybody's home or work.
//
// The coordinates are road geometry from OpenStreetMap (© OpenStreetMap contributors, ODbL,
// https://www.openstreetmap.org/copyright), worked out once with the public OSRM demo router and
// thinned to the corners. They are written down here so that making a track needs no network.
// Each is [longitude, latitude]. Neighbouring pieces share their end point.

/** @typedef {readonly [lng: number, lat: number]} LngLat */

// Trade and Tryon, then South Tryon Street, East 3rd Street and Providence Road as far as the
// left turn where Providence Road leaves Queens Road (4.4 km).
const toTurn = [
  [-80.84316, 35.22716],
  [-80.84530, 35.22567],
  [-80.83901, 35.22022],
  [-80.83527, 35.21691],
  [-80.83435, 35.21622],
  [-80.83260, 35.21519],
  [-80.83124, 35.21421],
  [-80.83053, 35.21341],
  [-80.82926, 35.21243],
  [-80.82880, 35.21179],
  [-80.82840, 35.21134],
  [-80.82792, 35.21097],
  [-80.82672, 35.21032],
  [-80.82630, 35.21003],
  [-80.82463, 35.20833],
  [-80.82435, 35.20792],
  [-80.82420, 35.20757],
  [-80.82413, 35.20718],
  [-80.82413, 35.20595],
  [-80.82512, 35.20112],
  [-80.82563, 35.19972],
  [-80.82704, 35.19635],
  [-80.82714, 35.19627],
  [-80.82728, 35.19597],
]

// Providence Road, from that turn to Colville Road (0.9 km).
const turnToLeave = [
  [-80.82728, 35.19597],
  [-80.82733, 35.19588],
  [-80.82707, 35.19573],
  [-80.82678, 35.19548],
  [-80.82382, 35.19152],
  [-80.82351, 35.19096],
  [-80.82255, 35.18865],
]

// Providence Road, from Colville Road to where Scotland Avenue comes back in (0.5 km).
const leaveToRejoin = [
  [-80.82255, 35.18865],
  [-80.82072, 35.18429],
]

// Providence Road, South Wendover Road and Sharon Road to SouthPark Mall (4.3 km).
const rejoinToEnd = [
  [-80.82072, 35.18429],
  [-80.82031, 35.18333],
  [-80.82032, 35.18321],
  [-80.82025, 35.18304],
  [-80.81834, 35.17846],
  [-80.81795, 35.17776],
  [-80.81755, 35.17733],
  [-80.81932, 35.17594],
  [-80.82001, 35.17532],
  [-80.82059, 35.17464],
  [-80.82094, 35.17410],
  [-80.82133, 35.17336],
  [-80.82157, 35.17310],
  [-80.82185, 35.17289],
  [-80.82317, 35.17218],
  [-80.82292, 35.17178],
  [-80.82246, 35.17007],
  [-80.82242, 35.16956],
  [-80.82251, 35.16857],
  [-80.82248, 35.16829],
  [-80.82228, 35.16788],
  [-80.82159, 35.16678],
  [-80.82141, 35.16625],
  [-80.82111, 35.16087],
  [-80.82116, 35.16062],
  [-80.82108, 35.15952],
  [-80.82113, 35.15921],
  [-80.82133, 35.15880],
  [-80.82218, 35.15761],
  [-80.82344, 35.15617],
  [-80.82452, 35.15501],
  [-80.82458, 35.15487],
  [-80.82533, 35.15411],
  [-80.82547, 35.15408],
  [-80.82689, 35.15285],
  [-80.82857, 35.15373],
  [-80.82869, 35.15354],
  [-80.82909, 35.15239],
  [-80.82919, 35.15241],
]

// The wrong turn: left into Colville Road, along Scotland Avenue (parallel to Providence Road,
// up to 250 m from it), and back to Providence Road (0.9 km instead of 0.5 km).
const detour = [
  [-80.82255, 35.18865],
  [-80.82055, 35.18923],
  [-80.81998, 35.18949],
  [-80.81876, 35.18659],
  [-80.81867, 35.18635],
  [-80.81865, 35.18600],
  [-80.81872, 35.18574],
  [-80.81895, 35.18541],
  [-80.81976, 35.18480],
  [-80.82044, 35.18441],
  [-80.82072, 35.18429],
]

// The missed turn: straight on along Queens Road instead of turning left (450 m).
const spur = [
  [-80.82728, 35.19597],
  [-80.82849, 35.19314],
  [-80.82896, 35.19216],
]
/**
 * Joins pieces end to end, dropping the point two neighbours share.
 * @param {readonly (readonly LngLat[])[]} pieces
 * @returns {LngLat[]}
 */
function join(...pieces) {
  /** @type {LngLat[]} */
  const line = []
  for (const piece of pieces) {
    for (const point of piece) {
      const last = line.at(-1)
      if (last === undefined || last[0] !== point[0] || last[1] !== point[1]) line.push(point)
    }
  }
  return line
}

/**
 * The drives that can be asked for by name.
 * - `uptown-to-southpark`: the route, start to end (10.2 km).
 * - `wrong-turn`: the route, but at 5.3 km it turns into Colville Road and runs along Scotland
 *   Avenue before coming back to Providence Road and carrying on (10.6 km).
 * - `turn-around`: the route, but at 4.4 km it misses the left turn, carries on 450 m along
 *   Queens Road, turns around, comes back to the turn and carries on (11.1 km).
 * @type {Readonly<Record<string, { readonly about: string, readonly waypoints: readonly LngLat[] }>>}
 */
export const PRESETS = {
  'uptown-to-southpark': {
    about: 'Uptown (Trade and Tryon) to SouthPark Mall, on the route',
    waypoints: join(toTurn, turnToLeave, leaveToRejoin, rejoinToEnd),
  },
  'wrong-turn': {
    about: 'the same drive, with a wrong turn onto Scotland Avenue 5.3 km in',
    waypoints: join(toTurn, turnToLeave, detour, rejoinToEnd),
  },
  'turn-around': {
    about: 'the same drive, missing the left turn 4.4 km in, then turning around 450 m later',
    waypoints: join(toTurn, spur, spur.toReversed(), turnToLeave, leaveToRejoin, rejoinToEnd),
  },
}

/** Meters along a preset to the point where it leaves the route: handy with `--from-m`. */
export const PRESET_LEAVES_ROUTE_AT_M = { 'wrong-turn': 5320, 'turn-around': 4385 }
