// The one real sample trip every screen uses. Nothing here is invented beyond
// where the lights fall along each strip (the counts are real: 21 and 23).
export const TRIP = {
  from: 'Uptown Charlotte',
  to: 'Indian Land, SC',
  fast: { min: 35, mi: 21, lights: 21, tag: 'Fastest right now' },
  slow: { min: 43, mi: 24, lights: 23, tag: '8 min slower' },
  turn: { dist: 0.8, road: 'Johnston Rd' },
  // Sample only (from issue #45): how far the next manoeuvre is on the long straight
  straight: { dist: 12 },
  saves: 8,
  arrive: { fast: '10:16', slow: '10:24' }, // 9:41 on the status bar + trip time
}

// Where each traffic light sits along the route, 0 to 1. City at both ends,
// open road in the middle. The app knows where lights are, never their colour.
export const LIGHTS_FAST = [0.03, 0.06, 0.09, 0.13, 0.17, 0.21, 0.26, 0.31, 0.4, 0.47, 0.63, 0.68, 0.72, 0.76, 0.8, 0.83, 0.86, 0.89, 0.92, 0.95, 0.98]
export const LIGHTS_SLOW = [0.03, 0.06, 0.09, 0.12, 0.16, 0.2, 0.24, 0.28, 0.33, 0.38, 0.44, 0.5, 0.57, 0.66, 0.7, 0.74, 0.78, 0.82, 0.86, 0.89, 0.92, 0.95, 0.98]
// Slow stretches, as [from, to] along the route
export const SLOW_FAST: [number, number][] = [[0.51, 0.6]]
export const SLOW_SLOW: [number, number][] = [[0.395, 0.435], [0.585, 0.65]]
