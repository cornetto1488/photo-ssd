import WidgetKit
import SwiftUI
#if canImport(ActivityKit)
import ActivityKit
#endif

// MARK: - Данные

struct ZaletEntry: TimelineEntry {
    let date: Date
    let snap: WidgetSnapshot
    let hasData: Bool
}

struct ZaletProvider: TimelineProvider {
    func placeholder(in context: Context) -> ZaletEntry { ZaletEntry(date: Date(), snap: .placeholder, hasData: true) }

    func getSnapshot(in context: Context, completion: @escaping (ZaletEntry) -> Void) {
        let s = WidgetSnapshot.read()
        completion(ZaletEntry(date: Date(), snap: s ?? .placeholder, hasData: s != nil || context.isPreview))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ZaletEntry>) -> Void) {
        let s = WidgetSnapshot.read()
        let entry = ZaletEntry(date: Date(), snap: s ?? .placeholder, hasData: s != nil)
        completion(Timeline(entries: [entry], policy: .after(Date(timeIntervalSinceNow: 30 * 60))))
    }
}

// MARK: - Виды

struct WidgetBackground: View {
    var body: some View {
        ZStack {
            Theme.bg
            RadialGradient(colors: [Theme.acc.opacity(0.35), .clear], center: .bottomTrailing, startRadius: 4, endRadius: 180)
        }
    }
}

struct OnlineBadge: View {
    let online: Bool
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(online ? Theme.live : Theme.danger).frame(width: 6, height: 6)
            Text(online ? "В СЕТИ" : "ОФЛАЙН").font(F.mono(8, 600)).tracking(0.8).foregroundColor(Theme.muted)
        }
    }
}

struct SmallWidgetView: View {
    let e: ZaletEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                ZaletWordmark(size: 13)
                Spacer()
                OnlineBadge(online: e.snap.online)
            }
            Spacer()
            if e.hasData {
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text("\(e.snap.percent)").font(F.display(46, 800)).foregroundStyle(Theme.accGradient)
                    Text("%").font(F.display(20, 800)).foregroundColor(Theme.ink)
                }
                Text("НА SSD").font(F.display(13, 800)).foregroundColor(Theme.ink)
                Capsule().fill(Theme.panel2).frame(height: 4)
                    .overlay(alignment: .leading) {
                        GeometryReader { g in
                            Capsule().fill(Theme.accGradient).frame(width: g.size.width * CGFloat(e.snap.percent) / 100)
                        }
                    }
                    .padding(.top, 6)
                Text(subtitle).font(F.mono(9)).foregroundColor(Theme.muted).padding(.top, 5).lineLimit(1)
            } else {
                Text("Откройте ZALET").font(F.display(15, 700)).foregroundColor(Theme.ink)
            }
        }
    }

    private var subtitle: String {
        if e.snap.syncing { return "выгружается…" }
        if let d = e.snap.lastSync { return "обновлено " + d.formatted(.relative(presentation: .named)) }
        return "\(e.snap.done) из \(e.snap.total)"
    }
}

struct MediumWidgetView: View {
    let e: ZaletEntry
    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 0) {
                ZaletWordmark(size: 14)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text("\(e.snap.percent)").font(F.display(54, 800)).foregroundStyle(Theme.accGradient)
                    Text("%").font(F.display(22, 800)).foregroundColor(Theme.ink)
                }
                Text("ВЫГРУЖЕНО НА SSD").font(F.display(12, 800)).foregroundColor(Theme.ink)
            }
            VStack(alignment: .leading, spacing: 10) {
                OnlineBadge(online: e.snap.online)
                Spacer()
                Metric(label: "Файлов", value: "\(e.snap.done) / \(e.snap.total)")
                Metric(label: "На SSD", value: formatBytes(e.snap.bytes))
                Metric(label: "Свободно", value: e.snap.free > 0 ? formatBytes(e.snap.free) : "—")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct Metric: View {
    let label: String, value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased()).font(F.mono(8, 500)).tracking(0.8).foregroundColor(Theme.muted)
            Text(value).font(F.sans(13, 600)).foregroundColor(Theme.ink).lineLimit(1).minimumScaleFactor(0.7)
        }
    }
}

struct ZaletWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: ZaletEntry

    var body: some View {
        switch family {
        case .systemMedium:
            MediumWidgetView(e: entry).widgetPadding().widgetBG()
        case .accessoryCircular:
            Gauge(value: Double(entry.snap.percent), in: 0...100) {
                Image(systemName: "externaldrive.fill")
            } currentValueLabel: {
                Text("\(entry.snap.percent)").font(.system(size: 16, weight: .heavy))
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .widgetBGClear()
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Text("ZALET").font(.system(size: 12, weight: .heavy))
                Text("\(entry.snap.percent)% на SSD").font(.system(size: 15, weight: .bold))
                Text(entry.snap.online ? "роутер в сети" : "нет связи").font(.system(size: 11))
            }
            .widgetBGClear()
        case .accessoryInline:
            Text("ZALET \(entry.snap.percent)% на SSD").widgetBGClear()
        default:
            SmallWidgetView(e: entry).widgetPadding().widgetBG()
        }
    }
}

extension View {
    @ViewBuilder func widgetBG() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { WidgetBackground() }
        } else {
            background(WidgetBackground())
        }
    }
    @ViewBuilder func widgetBGClear() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { Color.clear }
        } else {
            self
        }
    }
    @ViewBuilder func widgetPadding() -> some View {
        if #available(iOS 17.0, *) { self } else { padding(16) }
    }
}

struct ZaletStatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ZaletStatus", provider: ZaletProvider()) { entry in
            ZaletWidgetView(entry: entry)
        }
        .configurationDisplayName("ZALET")
        .description("Сколько фото уже на SSD и связь с роутером.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Live Activity

#if canImport(ActivityKit)
@available(iOS 16.2, *)
struct ZaletLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ZaletActivityAttributes.self) { ctx in
            LockScreenActivity(state: ctx.state)
                .activityBackgroundTint(Theme.bg)
                .activitySystemActionForegroundColor(Theme.acc)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ZaletWordmark(size: 14).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("\(Int(ctx.state.progress * 100))%").font(F.display(20, 800)).foregroundStyle(Theme.accGradient)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: ctx.state.progress).tint(Theme.acc)
                        HStack {
                            Text(ctx.state.finished ? "Готово · залетело \(ctx.state.uploaded)" : (ctx.state.current.isEmpty ? "выгрузка…" : ctx.state.current))
                                .font(F.mono(11)).foregroundColor(Theme.muted).lineLimit(1)
                            Spacer()
                            Text("\(ctx.state.done)/\(ctx.state.total)").font(F.mono(11, 600)).foregroundColor(Theme.ink)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: ctx.state.finished ? "checkmark.circle.fill" : "arrow.up.circle.fill").foregroundColor(Theme.acc)
            } compactTrailing: {
                Text("\(Int(ctx.state.progress * 100))%").font(.system(size: 13, weight: .heavy)).foregroundColor(Theme.acc)
            } minimal: {
                Image(systemName: "arrow.up").foregroundColor(Theme.acc)
            }
            .keylineTint(Theme.acc)
        }
    }
}

@available(iOS 16.2, *)
struct LockScreenActivity: View {
    let state: ZaletActivityAttributes.ContentState
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                ZaletWordmark(size: 16)
                Spacer()
                Text(state.finished ? "ГОТОВО" : "ВЫГРУЗКА НА SSD").font(F.mono(10, 600)).tracking(1).foregroundColor(Theme.muted)
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(Int(state.progress * 100))").font(F.display(40, 800)).foregroundStyle(Theme.accGradient)
                Text("%").font(F.display(18, 800)).foregroundColor(Theme.ink)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(state.done) из \(state.total)").font(F.mono(12, 600)).foregroundColor(Theme.ink)
                    if state.finished {
                        Text("залетело \(state.uploaded)").font(F.mono(11)).foregroundColor(Theme.live)
                    } else if state.speed > 0 {
                        Text("\(formatBytes(Int64(state.speed)))/с").font(F.mono(11)).foregroundColor(Theme.acc2)
                    }
                }
            }
            ProgressView(value: state.progress).tint(Theme.acc)
            if !state.current.isEmpty && !state.finished {
                Text(state.current).font(F.mono(10)).foregroundColor(Theme.muted).lineLimit(1)
            }
        }
        .padding(16)
    }
}
#endif

// MARK: - Пакет

@main
struct ZaletWidgetBundle: WidgetBundle {
    var body: some Widget {
        ZaletStatusWidget()
        ZaletLiveActivity()
    }
}
