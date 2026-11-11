import Foundation
import XCTest
import RouteIQCore

// Mirrors, from the Vitest suites:
// - tests/routeFacts.test.ts: every describe except routeFeatures (map-layer
//   code, not part of the core).
// - tests/signals.test.ts, describe "formatSignalCount" (formatSignalCount and signalCountNote).
// Every coordinate is an invented point; no real addresses.
final class FormatTests: XCTestCase {
    // MARK: - Helpers

    /// routeFacts.test.ts `route(id, durationSec, typicalDurationSec = null)`.
    private static func route(_ id: String, _ durationSec: Double, _ typicalDurationSec: Double? = nil) -> RouteCandidate {
        RouteCandidate(
            id: id,
            geometry: [LngLat(-80.84, 35.22), LngLat(-80.83, 35.15)],
            durationSec: durationSec,
            typicalDurationSec: typicalDurationSec,
            distanceM: 9000,
            signalCount: nil,
            signalCoverage: .none,
            providerSignalCount: nil,
            intersections: nil,
            limitedAccessSpansM: nil,
            maneuvers: []
        )
    }

    // MARK: - describe('delayVsTypicalSec')

    // it('is positive when slower than typical and negative when faster')
    func testDelayVsTypicalSec_isPositiveWhenSlowerAndNegativeWhenFaster() {
        XCTAssertEqual(Format.delayVsTypicalSec(Self.route("a", 900, 780)), 120)
        XCTAssertEqual(Format.delayVsTypicalSec(Self.route("a", 840, 860)), -20)
        XCTAssertEqual(Format.delayVsTypicalSec(Self.route("a", 600, 600)), 0)
    }

    // it('is null, not a guess, when there is no typical duration')
    func testDelayVsTypicalSec_isNilNotAGuessWhenThereIsNoTypicalDuration() {
        XCTAssertNil(Format.delayVsTypicalSec(Self.route("a", 900, nil)))
        XCTAssertNil(Format.delayVsTypicalSec(Self.route("a", 900, Double.nan)))
        XCTAssertNil(Format.delayVsTypicalSec(Self.route("a", Double.nan, 780)))
    }

    // MARK: - describe('formatDuration')

    // it('rounds to minutes and switches to hours at 60')
    func testFormatDuration_roundsToMinutesAndSwitchesToHoursAt60() {
        XCTAssertEqual(Format.formatDuration(840), "14 min")
        XCTAssertEqual(Format.formatDuration(869), "14 min")
        XCTAssertEqual(Format.formatDuration(870), "15 min")
        XCTAssertEqual(Format.formatDuration(3570), "1 h")
        XCTAssertEqual(Format.formatDuration(3600), "1 h")
        XCTAssertEqual(Format.formatDuration(3900), "1 h 5 min")
    }

    // it('never shows less than a minute and refuses nonsense')
    func testFormatDuration_neverShowsLessThanAMinuteAndRefusesNonsense() {
        XCTAssertEqual(Format.formatDuration(0), "1 min")
        XCTAssertEqual(Format.formatDuration(10), "1 min")
        XCTAssertEqual(Format.formatDuration(-5), "n/a")
        XCTAssertEqual(Format.formatDuration(Double.nan), "n/a")
        XCTAssertEqual(Format.formatDuration(Double.infinity), "n/a")
    }

    // MARK: - describe('formatDistance')

    // it('uses miles, one decimal under ten')
    func testFormatDistance_usesMilesOneDecimalUnderTen() {
        XCTAssertEqual(Format.formatDistance(1609.344), "1.0 mi")
        XCTAssertEqual(Format.formatDistance(9300), "5.8 mi")
        XCTAssertEqual(Format.formatDistance(16_050), "10 mi")
        XCTAssertEqual(Format.formatDistance(40_233.6), "25 mi")
    }

    // it('uses feet under a tenth of a mile')
    func testFormatDistance_usesFeetUnderATenthOfAMile() {
        XCTAssertEqual(Format.formatDistance(0), "0 ft")
        XCTAssertEqual(Format.formatDistance(100), "330 ft")
        XCTAssertEqual(Format.formatDistance(161), "0.1 mi")
    }

    // it('refuses nonsense')
    func testFormatDistance_refusesNonsense() {
        XCTAssertEqual(Format.formatDistance(-1), "n/a")
        XCTAssertEqual(Format.formatDistance(Double.nan), "n/a")
    }

    // MARK: - describe('formatDelay')

    // it('says slower, faster, or about typical')
    func testFormatDelay_saysSlowerFasterOrAboutTypical() {
        XCTAssertEqual(Format.formatDelay(180), "3 min slower than typical")
        XCTAssertEqual(Format.formatDelay(-120), "2 min faster than typical")
        XCTAssertEqual(Format.formatDelay(20), "About the typical time")
        XCTAssertEqual(Format.formatDelay(-29), "About the typical time")
        XCTAssertEqual(Format.formatDelay(0), "About the typical time")
    }

    // it('says so when there is no typical time')
    func testFormatDelay_saysSoWhenThereIsNoTypicalTime() {
        XCTAssertEqual(Format.formatDelay(nil), "No typical time available")
        XCTAssertEqual(Format.formatDelay(Double.nan), "No typical time available")
    }

    // MARK: - describe('formatLatLng')

    // it('puts latitude first for reading')
    func testFormatLatLng_putsLatitudeFirstForReading() {
        XCTAssertEqual(Format.formatLatLng(LngLat(-80.84312, 35.22714)), "35.2271, -80.8431")
    }

    // MARK: - describe('formatDataMonth')

    // it('names the month a dataset dates from, in UTC, or nothing')
    func testFormatDataMonth_namesTheMonthADatasetDatesFromInUTCOrNothing() {
        // Date.UTC(2026, 10, 10, 21, 21, 39)
        XCTAssertEqual(Format.formatDataMonth(1_794_345_699_000), "Nov 2026")
        // The last second of a month and the first of the next, wherever the reader is.
        // Date.UTC(2026, 11, 31, 23, 59, 59)
        XCTAssertEqual(Format.formatDataMonth(1_798_761_599_000), "Dec 2026")
        // Date.UTC(2027, 0, 1)
        XCTAssertEqual(Format.formatDataMonth(1_798_761_600_000), "Jan 2027")
        XCTAssertNil(Format.formatDataMonth(nil))
        XCTAssertNil(Format.formatDataMonth(Double.nan))
        XCTAssertNil(Format.formatDataMonth(8.7e15))
    }

    // MARK: - describe('formatSignalCount') (tests/signals.test.ts)

    // it('counts in words and never shows an unknown count as zero')
    func testFormatSignalCount_countsInWordsAndNeverShowsAnUnknownCountAsZero() {
        XCTAssertEqual(Format.formatSignalCount(14), "14 signals")
        XCTAssertEqual(Format.formatSignalCount(1), "1 signal")
        XCTAssertEqual(Format.formatSignalCount(0), "0 signals")
        XCTAssertEqual(Format.formatSignalCount(nil), "Signals: unknown")
        // TS formatSignalCount(NaN): a NaN count is nil in Swift (signalCount is Int?).
        XCTAssertEqual(Format.formatSignalCount(nil, .full), "Signals: unknown")
        XCTAssertEqual(Format.formatSignalCount(-1), "Signals: unknown")
        // TS formatSignalCount(2.5) is not representable: the count is an Int.
    }

    // it('shows a partial count as a lower bound, and never as a plain number or as zero')
    func testFormatSignalCount_showsAPartialCountAsALowerBoundNeverAsAPlainNumberOrZero() {
        XCTAssertEqual(Format.formatSignalCount(9, .partial), "≥ 9 signals (partial)")
        XCTAssertEqual(Format.formatSignalCount(1, .partial), "≥ 1 signal (partial)")
        // "At least 0" says nothing, and "0 signals" would be a claim: unknown it is.
        XCTAssertEqual(Format.formatSignalCount(0, .partial), "Signals: unknown")
        XCTAssertEqual(Format.formatSignalCount(nil, .partial), "Signals: unknown")
        XCTAssertEqual(Format.formatSignalCount(14, .none), "Signals: unknown")
        XCTAssertEqual(Format.formatSignalCount(nil, .none), "Signals: unknown")
        XCTAssertEqual(Format.formatSignalCount(14, .full), "14 signals")
        XCTAssertEqual(Format.formatSignalCount(0, .full), "0 signals")
    }

    // it('explains a count that is not whole, and says nothing about one that is')
    func testFormatSignalCount_explainsACountThatIsNotWholeAndSaysNothingAboutOneThatIs() {
        XCTAssertNil(Format.signalCountNote(24, .full))
        XCTAssertNil(Format.signalCountNote(0, .full))
        XCTAssertEqual(
            Format.signalCountNote(9, .partial),
            "Signal data for part of this route is missing, so this is a lower bound."
        )
        // Where the label says unknown, so does the note.
        let unknowns: [(count: Int?, coverage: SignalCoverage)] = [
            (count: 0, coverage: SignalCoverage.partial),
            (count: nil, coverage: SignalCoverage.partial),
            (count: nil, coverage: SignalCoverage.none),
            (count: 14, coverage: SignalCoverage.none),
        ]
        for item in unknowns {
            XCTAssertEqual(Format.formatSignalCount(item.count, item.coverage), "Signals: unknown")
            XCTAssertEqual(
                Format.signalCountNote(item.count, item.coverage),
                "Signal data for this route could not be loaded."
            )
        }
    }
}
