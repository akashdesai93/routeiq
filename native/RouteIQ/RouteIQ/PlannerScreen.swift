import SwiftUI
import RouteIQCore
import RouteIQKit

/// The first screen: a map with the routes between two public test points,
/// and the ranked route list under it. Everything shown comes ready-made
/// from RouteIQKit; this view only lays it out.
struct PlannerScreen: View {
    @State private var plan: RoutePlan = .idle
    @State private var selectedId: String?
    /// Bumped by "Try again". `.task(id:)` cancels the running load and starts a new one.
    @State private var attempt = 0

    @State private var signalCredit: String?

    private let tokenStatus = MapboxToken.check(Bundle.main.object(forInfoDictionaryKey: "MBXAccessToken") as? String)

    /// The OpenStreetMap signal tiles shipped in the app (osm-signals.json, packed by
    /// native/scripts/pack-signal-bundle.mjs), read once in the background.
    private static let signals = SignalBundleLoader(url: Bundle.main.url(forResource: "osm-signals", withExtension: "json"))

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
        .task(id: attempt) { await load() }
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
                    Button("Try again") { attempt += 1 }
                }
                .padding()
            case .routes(let rows):
                List {
                    ForEach(rows) { row in
                        RouteRowView(row: row, isSelected: row.id == (selectedId ?? rows.first?.id))
                            .contentShape(Rectangle())
                            .onTapGesture { selectedId = row.id }
                    }
                    if let signalCredit {
                        // The OpenStreetMap license asks for this credit wherever the data is used.
                        Text(signalCredit)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
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
        let bundle = await Self.signals.bundle()
        // A load that was replaced by a newer one leaves the screen to it.
        if Task.isCancelled { return }
        signalCredit = bundle?.creditLine
        plan = RoutePlan.from(result, signals: bundle)
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
