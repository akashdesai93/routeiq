import Foundation

/// Public landmarks and intersections used as fixed test coordinates, ported
/// from src/core/testPoints.ts. Deliberately not anyone's home or work address.
public enum TestPoints {
    public static let uptownCharlotte = Place(id: "uptown", label: "Uptown Charlotte (Trade & Tryon)", position: LngLat(-80.8431, 35.2271))

    /// Where SC-160 (Fort Mill Hwy) ends at US-521 in Indian Land, South Carolina.
    public static let indianLand = Place(id: "indian-land", label: "Indian Land, SC (US-521 & SC-160)", position: LngLat(-80.8561, 35.0015))

    public static let southPark = Place(id: "southpark", label: "SouthPark (south Charlotte)", position: LngLat(-80.8295, 35.1527))

    /// The trip the app opens with: Uptown down the US-521 corridor into South Carolina.
    public static let defaultTrip = (origin: uptownCharlotte, destination: indianLand)

    public static let all: [Place] = [uptownCharlotte, indianLand, southPark]
}
