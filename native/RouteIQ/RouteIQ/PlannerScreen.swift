import SwiftUI
import RouteIQCore
import RouteIQKit

/// The first screen: a map with the routes between two public test points,
/// and the ranked route list under it. Everything shown comes ready-made
/// from RouteIQKit; this view only lays it out.
struct PlannerScreen: View {
    @State private var plan: RoutePlan = .idle
    @State private var selectedId: String?

    private let tokenStatus = MapboxToken.check(Bundle.main.object(forInfoDictionaryKey: "MBXAccessToken") as? String)

    private var rows: [RouteRow] {
        if case .routes(let rows) = plan { return rows }
        return []
    }

    var body: some View {
        VStack(spacing: 0) {
            RouteMapView(rows: rows, selectedId: selectedId ?? rows.first?.id)
                .frame(maxHeight: .infinity)
            routePanel
                .frame(maxHeight: 320)
        }
        .task { await load() }
    }

    @ViewBuilder
    private var routePanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(DemoTrip.origin.label) → \(DemoTrip.destination.label)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
                .padding(.top, 8)
            switch plan {
            case .idle, .loading:
                ProgressView("Finding routes…")
                    .frame(maxWidth: .infinity)
                    .padding()
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                    Button("Try again") { Task { await load() } }
                }
                .padding()
            case .routes(let rows):
                List(rows) { row in
                    RouteRowView(row: row, isSelected: row.id == (selectedId ?? rows.first?.id))
                        .contentShape(Rectangle())
                        .onTapGesture { selectedId = row.id }
                }
                .listStyle(.plain)
            }
        }
    }

    private func load() async {
        guard case .ok(let token) = tokenStatus else {
            plan = .failed(MapboxToken.help(tokenStatus) ?? "No Mapbox token.")
            return
        }
        plan = .loading
        let result = await DirectionsClient().fetch(
            origin: DemoTrip.origin.position,
            destination: DemoTrip.destination.position,
            token: token
        )
        plan = RoutePlan.from(result)
        selectedId = nil
    }
}

struct RouteRowView: View {
    let row: RouteRow
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.eta).font(.title3.weight(.semibold))
                Text(row.distance).foregroundStyle(.secondary)
                Spacer()
                if row.isRecommended {
                    Text("Recommended")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                }
            }
            Text(row.reason).font(.subheadline)
            HStack {
                Text(row.delay)
                Text("·")
                Text(row.signals)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .background(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        .accessibilityElement(children: .combine)
    }
}
