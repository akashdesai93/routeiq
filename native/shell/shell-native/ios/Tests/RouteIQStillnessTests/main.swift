import Foundation

// The rules of RouteIQStillness (#98): which fixes and ticks reach the web app
// while the car stands still. Plain Swift, no XCTest and no iOS, so it runs on
// Linux and macOS alike: native/shell/scripts/test-swift-logic.sh.

var failures = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok {
        failures += 1
        print("FAIL line \(line): \(what)")
    }
}

let d = RouteIQStillness.defaultOptions
/// Charlotte, a public landmark (Bank of America Stadium).
let lat = 35.2258, lng = -80.8528
/// `m` meters north of the stadium.
func north(_ m: Double) -> Double { lat + m / 111_195 }

/// One fix a second, as Core Location gives with no distance filter.
/// Returns the seconds at which a fix was passed on.
func parked(_ gate: inout RouteIQStillness, from: Double, seconds: Int, drift: Double = 0) -> [Double] {
    var sent: [Double] = []
    for i in 0..<seconds {
        let t = from + Double(i)
        let wobble = drift * sin(Double(i) * 0.7)
        if gate.fix(lat: north(wobble), lng: lng, speedMps: 0, nowSec: t) { sent.append(t) }
    }
    return sent
}

func largestGap(_ times: [Double]) -> Double {
    zip(times, times.dropFirst()).map { $1 - $0 }.max() ?? 0
}

// The defaults keep the web app's own rules working (tests/stillness.test.ts checks them
// against the web constants): a held fix waits keepAliveSec plus up to one GPS second,
// inside maxFixAgeSec (10 s) and the diagnostics' tick-gap line (5 s); a stop below 1 m/s.
check(d.keepAliveSec + 1 < 5, "keepAliveSec plus a GPS second under 5 s")
check(d.stillSpeedMps < 1, "stillSpeedMps under the web tracker's stoppedSpeedMps")

do {
    // Moving: every fix goes through; the ticks in between do not (the fixes are the clock).
    var g = RouteIQStillness()
    var fixes = true
    var ticks = 0
    for i in 0..<120 {
        let t = Double(i)
        fixes = fixes && g.fix(lat: north(Double(i) * 15), lng: lng, speedMps: 15, nowSec: t)
        if g.tick(nowSec: t + 0.5) { ticks += 1 }
    }
    check(fixes, "moving: every fix is passed on")
    check(ticks == 0, "moving: no tick while fixes flow (got \(ticks))")
    // A tunnel: the fixes stop, and the ticks are back within tickQuietSec, every second.
    var tunnel: [Double] = []
    for i in 0..<30 { if g.tick(nowSec: 119.5 + Double(i)) { tunnel.append(119.5 + Double(i)) } }
    check(tunnel.first == 120.5, "the first tick after the last fix at 119 s comes at 120.5 s (got \(tunnel.first ?? -1))")
    check(tunnel.count == 29 && largestGap(tunnel) == 1, "then a tick every second")
}

do {
    // Ten minutes parked: the first holdAfterSec of fixes, then one every keepAliveSec.
    var g = RouteIQStillness()
    let sent = parked(&g, from: 0, seconds: 600)
    check(sent.prefix(10) == [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "the first 10 s of standing still pass: a red light changes nothing")
    check(sent.count == 10 + 196, "600 s parked: 206 fixes passed on instead of 600 (0-9 s, then 12, 15, ... 597 s) (got \(sent.count))")
    check(largestGap(sent) <= d.keepAliveSec, "a fix at least every keepAliveSec while parked (gap \(largestGap(sent)))")
    check(g.holding(nowSec: 600), "holding after 10 minutes")
}

do {
    // Parked GPS drift with a speed of 0 is still standing still; the hold stays.
    var g = RouteIQStillness()
    let sent = parked(&g, from: 0, seconds: 300, drift: 20)
    check(sent.count < 120, "drift within 20 m stays held (got \(sent.count))")
}

do {
    // Resume by speed: after five minutes parked, the first fix with speed passes at once.
    var g = RouteIQStillness()
    _ = parked(&g, from: 0, seconds: 300)
    check(g.holding(nowSec: 300), "holding before moving off")
    check(g.fix(lat: lat, lng: lng, speedMps: 1.5, nowSec: 300.2), "the first moving fix is passed on at once")
    check(!g.holding(nowSec: 300.2), "moving ends the hold")
    var next = true
    for i in 1...20 { next = next && g.fix(lat: north(Double(i) * 2), lng: lng, speedMps: 2, nowSec: 300.2 + Double(i)) }
    check(next, "every fix after moving off is passed on")
}

do {
    // Resume by distance: a phone that says speed 0 but is 30 m away has moved.
    var g = RouteIQStillness()
    _ = parked(&g, from: 0, seconds: 120)
    check(g.fix(lat: north(30), lng: lng, speedMps: 0, nowSec: 120.5), "30 m from the stop is moving, whatever the speed says")
}

do {
    // Creeping in a queue (0.6 m/s): never held.
    var g = RouteIQStillness()
    var all = true
    for i in 0..<120 { all = all && g.fix(lat: north(Double(i) * 0.6), lng: lng, speedMps: 0.6, nowSec: Double(i)) }
    check(all, "creeping at 0.6 m/s is moving")
}

do {
    // Unknown speed is passed on: when in doubt, the web app decides.
    var g = RouteIQStillness()
    _ = parked(&g, from: 0, seconds: 60)
    check(g.fix(lat: lat, lng: lng, speedMps: nil, nowSec: 60.3), "a fix with no speed is passed on")
}

do {
    // Ticks between held fixes must not use up the fix's turn: the web app still gets a fix every keepAliveSec.
    var g = RouteIQStillness()
    var fixes: [Double] = []
    var events: [Double] = []
    for i in 0..<300 {
        let t = Double(i)
        if g.fix(lat: lat, lng: lng, speedMps: 0, nowSec: t) { fixes.append(t); events.append(t) }
        if g.tick(nowSec: t + 0.5) { events.append(t + 0.5) }
    }
    check(largestGap(fixes) <= d.keepAliveSec, "with ticks in between, a fix every keepAliveSec (gap \(largestGap(fixes)))")
    check(largestGap(events) <= d.keepAliveSec, "and an event of some kind every keepAliveSec")
    let heldTicks = events.filter { $0 > 20 && $0 != $0.rounded() }.count
    check(heldTicks == 0, "while held, the keep-alive fixes are the web app's clock: no extra ticks (got \(heldTicks))")
}

do {
    // GPS lost while parked (a garage): the ticks go on, one every keepAliveSec, so the web app notices.
    var g = RouteIQStillness()
    _ = parked(&g, from: 0, seconds: 60)
    var ticks: [Double] = [59]
    for i in 60..<180 { if g.tick(nowSec: Double(i)) { ticks.append(Double(i)) } }
    check(ticks.count >= 120 / Int(d.keepAliveSec), "ticks go on without fixes (got \(ticks.count))")
    check(ticks.count <= 120 / Int(d.keepAliveSec) + 2, "and no more than one every keepAliveSec (got \(ticks.count))")
    check(largestGap(ticks) <= d.keepAliveSec, "a tick at least every keepAliveSec without fixes")
}

do {
    // Not held yet: ticks every second, as before (a tunnel while driving is noticed at once).
    var g = RouteIQStillness()
    var all = true
    for i in 0..<30 { all = all && g.tick(nowSec: Double(i)) }
    check(all, "ticks every second when no stillness is known")
}

do {
    // A clock that steps back never holds a fix or a tick back.
    var g = RouteIQStillness()
    let sent = parked(&g, from: 1000, seconds: 60)
    check(g.fix(lat: lat, lng: lng, speedMps: 0, nowSec: 900), "a fix stamped before the stop began is passed on")
    var h = RouteIQStillness()
    let last = parked(&h, from: 1000, seconds: 60).last!
    check(h.holding(nowSec: last), "holding before the step back")
    check(h.fix(lat: lat, lng: lng, speedMps: 0, nowSec: last - 0.5), "a fix stamped just before the last one passed on is passed on")
    var k = RouteIQStillness()
    let lastK = parked(&k, from: 1000, seconds: 60).last!
    check(k.tick(nowSec: lastK - 0.5), "a tick stamped before the last event is sent")
    _ = sent
}

do {
    // A new drive starts with nothing held.
    var g = RouteIQStillness()
    _ = parked(&g, from: 0, seconds: 60)
    g.reset()
    check(!g.holding(nowSec: 61), "reset ends the hold")
    check(g.fix(lat: lat, lng: lng, speedMps: 0, nowSec: 61.5), "the first fix after reset is passed on")
}

if failures > 0 {
    print("\(failures) check(s) failed")
    exit(1)
}
print("RouteIQStillness: all checks passed")
