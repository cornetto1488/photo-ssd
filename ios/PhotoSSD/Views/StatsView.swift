import SwiftUI
import Charts

enum StatMetric: String, CaseIterable, Identifiable { case count = "Файлы", bytes = "Объём"; var id: String { rawValue } }

struct StatsView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var store: SyncStore
    @State private var stats: SSDStats?
    @State private var error: String?
    @State private var metric: StatMetric = .count
    @State private var range = 12

    private var months: [StatBucket] {
        guard let s = stats else { return [] }
        return Array(s.byMonth.suffix(range))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let s = stats {
                        totals(s)
                        monthsChart
                        kindsChart(s)
                        activityChart(s)
                        records(s)
                    } else if let error {
                        Panel { Text(error).font(F.sans(14)).foregroundColor(Theme.danger) }
                    } else {
                        ProgressView().tint(Theme.acc).frame(maxWidth: .infinity).padding(60)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Статистика")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        do { stats = try await ServerAPI.stats(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func totals(_ s: SSDStats) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MonoLabel(text: "Всего залетело", number: "01")
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(s.total)").font(F.display(56, 800)).foregroundStyle(Theme.accGradient)
                Text(NightReport.plural(s.total, "файл", "файла", "файлов")).font(F.display(22, 700)).foregroundColor(Theme.ink)
            }
            HStack(spacing: 10) {
                StatTile(value: formatBytes(s.bytes), label: "на SSD")
                StatTile(value: s.total == 0 ? "—" : formatBytes(s.bytes / Int64(max(1, s.total))), label: "средний файл")
            }
            if s.oldest > 0 {
                Text("с \(Date(timeIntervalSince1970: TimeInterval(s.oldest)).formatted(date: .long, time: .omitted)) по \(Date(timeIntervalSince1970: TimeInterval(s.newest)).formatted(date: .long, time: .omitted))")
                    .font(F.mono(11)).foregroundColor(Theme.muted)
            }
        }
    }

    private var monthsChart: some View {
        Panel {
            HStack {
                MonoLabel(text: "По месяцам съёмки", number: "02")
                Spacer()
                Menu {
                    ForEach([6, 12, 24, 60], id: \.self) { r in Button("\(r) мес.") { range = r } }
                } label: { Text("\(range) мес.").font(F.mono(11, 600)).foregroundColor(Theme.acc) }
            }
            Picker("", selection: $metric) {
                ForEach(StatMetric.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).padding(.top, 10)

            Chart(months) { b in
                BarMark(x: .value("Месяц", monthLabel(b.key)),
                        y: .value(metric.rawValue, metric == .count ? Double(b.count) : Double(b.bytes) / 1_000_000_000))
                    .foregroundStyle(Theme.accGradient)
                    .cornerRadius(4)
            }
            .chartYAxis {
                AxisMarks { v in
                    AxisGridLine().foregroundStyle(Theme.line)
                    AxisValueLabel {
                        if let d = v.as(Double.self) {
                            Text(metric == .count ? "\(Int(d))" : String(format: "%.1f ГБ", d)).font(F.mono(9)).foregroundColor(Theme.muted)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks { _ in AxisValueLabel().font(F.mono(8)).foregroundStyle(Theme.muted) }
            }
            .frame(height: 200)
            .padding(.top, 12)
        }
    }

    private func kindsChart(_ s: SSDStats) -> some View {
        let list = s.byKind.filter { $0.key != "livevideo" }.sorted { $0.count > $1.count }
        let maxCount = max(1, list.map(\.count).max() ?? 1)
        return Panel {
            MonoLabel(text: "По типам", number: "03")
            VStack(spacing: 12) {
                ForEach(list) { b in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(kindTitle(b.key)).font(F.sans(14, 500)).foregroundColor(Theme.ink)
                            Spacer()
                            Text("\(b.count) · \(formatBytes(b.bytes))").font(F.mono(11)).foregroundColor(Theme.muted)
                        }
                        ProgressBar(value: Double(b.count) / Double(maxCount)).frame(height: 6)
                    }
                }
            }.padding(.top, 12)
        }
    }

    private func activityChart(_ s: SSDStats) -> some View {
        Panel {
            MonoLabel(text: "Выгрузки за 30 дней", number: "04")
            if s.uploadsByDay.isEmpty {
                Text("За последний месяц ничего не выгружалось").font(F.sans(13)).foregroundColor(Theme.muted).padding(.top, 10)
            } else {
                Chart(s.uploadsByDay) { b in
                    BarMark(x: .value("День", dayDate(b.key), unit: .day), y: .value("Файлы", b.count))
                        .foregroundStyle(Theme.live.gradient)
                        .cornerRadius(2)
                }
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day, count: 7)) { _ in
                        AxisValueLabel(format: .dateTime.day().month(.abbreviated)).font(F.mono(8)).foregroundStyle(Theme.muted)
                    }
                }
                .chartYAxis { AxisMarks { _ in AxisGridLine().foregroundStyle(Theme.line); AxisValueLabel().font(F.mono(8)).foregroundStyle(Theme.muted) } }
                .frame(height: 140)
                .padding(.top, 12)
                .environment(\.locale, Locale(identifier: "ru_RU"))
            }
        }
    }

    private func records(_ s: SSDStats) -> some View {
        let top = s.byMonth.max { $0.count < $1.count }
        let heavy = s.byMonth.max { $0.bytes < $1.bytes }
        return Panel {
            MonoLabel(text: "Рекорды", number: "05")
            VStack(alignment: .leading, spacing: 10) {
                if let top { RecordRow(icon: "flame.fill", title: "Самый активный месяц", value: "\(monthLabel(top.key, full: true)) · \(top.count)") }
                if let heavy { RecordRow(icon: "scalemass.fill", title: "Самый тяжёлый месяц", value: "\(monthLabel(heavy.key, full: true)) · \(formatBytes(heavy.bytes))") }
                if s.biggest > 0 {
                    RecordRow(icon: "film.stack", title: "Самый большой файл",
                              value: "\((s.biggestPath as NSString).lastPathComponent) · \(formatBytes(s.biggest))")
                }
                RecordRow(icon: "iphone.and.arrow.forward", title: "С этого iPhone", value: "\(store.done.count) · \(formatBytes(store.totalBytes))")
            }.padding(.top, 12)
        }
    }

    private func monthLabel(_ key: String, full: Bool = false) -> String {
        let p = key.split(separator: "-")
        guard p.count == 2, let m = Int(p[1]), (1...12).contains(m) else { return key }
        let name = Layout.monthNames[m - 1]
        return full ? "\(name) \(p[0])" : "\(name.prefix(3)) \(p[0].suffix(2))"
    }

    private func dayDate(_ key: String) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: key) ?? Date()
    }

    private func kindTitle(_ k: String) -> String {
        switch k {
        case "photo": return "Фото"
        case "live": return "Live Photo"
        case "video": return "Видео"
        case "screenshot": return "Скриншоты"
        default: return "Другое"
        }
    }
}

struct RecordRow: View {
    let icon: String, title: String, value: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundColor(Theme.acc).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased()).font(F.mono(10, 500)).tracking(1).foregroundColor(Theme.muted)
                Text(value).font(F.sans(14, 500)).foregroundColor(Theme.ink).lineLimit(2)
            }
        }
    }
}
