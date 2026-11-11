import SwiftUI
import CoreLocation
import MapboxMaps
import RouteIQCore
import RouteIQKit

/// The routes on a Mapbox map. The selected (by default the recommended)
/// route is drawn last, on top, in the accent color; the others are grey.
/// API checked against the Maps SDK 11.34.2 source (Map, Viewport,
/// PolylineAnnotation, ForEvery, MapViewAnnotation).
struct RouteMapView: View {
    let rows: [RouteRow]
    let selectedId: String?

    @State private var viewport: Viewport = .camera(
        center: CLLocationCoordinate2D(latitude: DemoTrip.origin.position.lat, longitude: DemoTrip.origin.position.lng),
        zoom: 11
    )

    /// Others first, the selected one last so it is drawn over them.
    private var drawOrder: [RouteRow] {
        rows.filter { $0.id != selectedId } + rows.filter { $0.id == selectedId }
    }

    var body: some View {
        Map(viewport: $viewport) {
            ForEvery(drawOrder) { row in
                PolylineAnnotation(
                    id: "\(row.id)-\(row.id == selectedId ? "selected" : "other")",
                    lineCoordinates: row.geometry.map(Self.coordinate)
                )
                .lineColor(row.id == selectedId ? UIColor.systemBlue : UIColor.systemGray)
                .lineWidth(row.id == selectedId ? 7 : 5)
                .lineOpacity(row.id == selectedId ? 1 : 0.7)
            }
            MapViewAnnotation(coordinate: Self.coordinate(DemoTrip.origin.position)) {
                Pin(color: .green, label: "A")
            }
            MapViewAnnotation(coordinate: Self.coordinate(DemoTrip.destination.position)) {
                Pin(color: .red, label: "B")
            }
        }
        .mapStyle(.standard)
        .ignoresSafeArea(edges: .top)
        .onChange(of: rows.map(\.id)) { _, _ in fitRoutes() }
    }

    static func coordinate(_ p: LngLat) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: p.lat, longitude: p.lng)
    }

    /// Frames every route, both pins included.
    private func fitRoutes() {
        let points = rows.flatMap(\.geometry).map(Self.coordinate)
            + [DemoTrip.origin.position, DemoTrip.destination.position].map(Self.coordinate)
        withViewportAnimation(.easeInOut(duration: 0.8)) {
            viewport = Viewport.overview(geometry: MultiPoint(points)).padding(.all, 48)
        }
    }
}

/// A round marker with a letter, drawn in SwiftUI so no image asset is needed.
private struct Pin: View {
    let color: Color
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .frame(width: 24, height: 24)
            .background(Circle().fill(color))
            .overlay(Circle().stroke(.white, lineWidth: 2))
            .shadow(radius: 2)
    }
}
