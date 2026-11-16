# Jam bypass: the direction, the test and the kill line

Owner direction, 2026-11-16, after a real commute (39 min, 38 checks, best saving on offer
105 s, no switch). As a general GPS RouteIQ loses to the big apps: they have the live traffic.
This page is the one thing to drive at instead, and the line at which the idea is scrapped.

## The idea

**Get around jams on the main road through side streets, and be right about it.**

- A side street with nobody on it is not fast by itself. Rough numbers for one mile: the main
  road flowing takes about 80 s; a 25 mph side street with four stop signs takes about 200 s,
  and getting back onto a busy main road without a light adds 30 to 90 s. The side street wins
  only when the main road crawls (roughly under 13 mph over the stretch it skips).
- An empty street needs no traffic data. Its time follows from what the map has: length,
  speed limit, stop signs, turns. The only live data needed is how bad the jam on the main
  road is, and that data is good.
- So the app must do three things the current one does not:
  1. **Price the bypass with its own model.** Today a side-street probe asks Mapbox for a
     time and inherits its guess for streets it has little data on.
  2. **Decide at the turnoff, not on a timer.** Today a check runs once a minute and a
     switch needs two wins in a row, so a bypass can be confirmed after the turn has passed.
  3. **Learn its few numbers from the owner's drives:** the cost of a stop sign, of a turn,
     and of getting back onto the main road.

## The goal

Beat the big apps' route by **10 minutes a week** on the owner's commute, measured door to door.

## The test, before any of it is built

1. **Measure jam minutes** on every drive for two weeks (#227): time spent under 15 mph on
   main roads. This is the most a bypass could ever win.
2. **A free check by the owner:** drive Waze on alternate days and type its ETA at departure
   (the drive log already keeps "another app's ETA"). If its cut-throughs do not beat the
   usual time either, that says a lot.

## The kill line

- **Under about 5 jam minutes per drive** on average over the two weeks: there is nothing to
  bypass. Scrap the direction, with the numbers on the issue.
- **More than that:** build the bypass (#228), in the order above.

## What stays true

- The reroute engine stays conservative (CLAUDE.md rule 7). A bypass is a new kind of
  candidate with its own, tested rules; it does not loosen `DEFAULT_REROUTE_OPTIONS`.
- Unknown is never zero: a stretch whose stop signs or limits are not known has an unknown
  time and is not offered.
- A street that bans through traffic (`access=destination`, signed "no through traffic") is
  never used.
- Privacy as before: jam minutes are totals and distances into the drive, never positions.

## What was judged and dropped (so nobody re-proposes it blind)

- **Learning whole-route times from one driver:** one sample a day per route, with minutes
  of day-to-day noise. Proving a 2 minute gain takes weeks per option. The bypass model
  needs only a handful of numbers, which converge quickly.
- **Leave-time advice:** the big apps already have "depart at".
- **Counting the savings Mapbox offered** (the first #227): it reads low by construction,
  because Mapbox rarely offers side streets.
