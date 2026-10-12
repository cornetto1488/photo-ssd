import SwiftUI

struct RootView: View {
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            HomeView()
                .tabItem { Label("Главная", systemImage: "arrow.up.circle.fill") }.tag(0)
            LibraryView()
                .tabItem { Label("Медиатека", systemImage: "square.grid.3x3.fill") }.tag(1)
            SSDView()
                .tabItem { Label("SSD", systemImage: "externaldrive.fill") }.tag(2)
            StatsView()
                .tabItem { Label("Статистика", systemImage: "chart.bar.fill") }.tag(3)
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "slider.horizontal.3") }.tag(4)
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var store: SyncStore
    @EnvironmentObject var settings: AppSettings

    private var progress: Double {
        engine.totalInScope == 0 ? (store.done.isEmpty ? 0 : 1) : Double(engine.doneInScope) / Double(engine.totalInScope)
    }
    private var statusText: String {
        switch engine.state {
        case .scanning: return "Сканирую медиатеку · \(Int(engine.scanProgress * 100))%"
        case .syncing where engine.waitingWifi: return "Ждёт Wi-Fi · «Только по Wi-Fi» включено"
        default: return engine.state.title
        }
    }

    private var isBusy: Bool {
        switch engine.state { case .checking, .scanning, .syncing: return true; default: return false }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    hero
                    actions
                    if engine.state == .syncing { syncDetails }
                    if !engine.files.isEmpty && isBusy { filesPanel }
                    statsGrid
                    serverPanel
                    if let err = engine.lastError, !isBusy { errorPanel(err) }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(Theme.bg.ignoresSafeArea())
            .overlay(alignment: .topLeading) { FlightLayer(trigger: engine.landed, name: engine.lastLandedName) }
            .refreshable { await engine.refreshServer() }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        HStack {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 8).fill(Theme.accGradient).frame(width: 30, height: 30)
                    .overlay(Image(systemName: "paperplane.fill").font(.system(size: 14, weight: .black)).foregroundColor(Theme.bg))
                ZaletWordmark(size: 20)
            }
            Spacer()
            HStack(spacing: 8) {
                StatusDot(color: engine.serverOnline ? Theme.live : Theme.danger)
                Text(engine.serverOnline ? "РОУТЕР В СЕТИ" : "НЕТ СВЯЗИ")
                    .font(F.mono(10, 500)).tracking(1).foregroundColor(Theme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .overlay(Capsule().stroke(Theme.line2, lineWidth: 1))
        }
        .padding(.top, 8)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            MonoLabel(text: statusText, number: "01", color: engine.waitingWifi && engine.state == .syncing ? Theme.acc2 : Theme.muted)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(Int((progress * 100).rounded()))")
                    .font(F.display(92, 800))
                    .foregroundStyle(Theme.accGradient)
                    .contentTransition(.numericText())
                Text("%").font(F.display(40, 800)).foregroundColor(Theme.ink)
            }
            Text("ВЫГРУЖЕНО\nНА SSD").font(F.display(34, 800)).foregroundColor(Theme.ink).lineSpacing(-4)

            ProgressBar(value: progress).frame(height: 8)

            HStack {
                Text("\(engine.doneInScope) из \(engine.totalInScope)").font(F.mono(13, 500)).foregroundColor(Theme.ink)
                Spacer()
                if engine.state == .syncing && engine.speed > 0 {
                    Text("\(formatBytes(Int64(engine.speed)))/с").font(F.mono(13, 500)).foregroundColor(Theme.acc2)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack {
                Theme.panel
                RadialGradient(colors: [Theme.acc.opacity(0.28), .clear], center: .bottomTrailing, startRadius: 10, endRadius: 320)
                if engine.state == .syncing && !engine.waitingWifi { PaperPlaneFlight() }
            }
        )
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Theme.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }

    private var actions: some View {
        HStack(spacing: 10) {
            if isBusy {
                Button { engine.pause() } label: { Label("Пауза", systemImage: "pause.fill") }
                    .buttonStyle(AccentButtonStyle(filled: false))
            } else {
                Button { engine.start() } label: { Label("Синхронизировать", systemImage: "arrow.up.circle.fill") }
                    .buttonStyle(AccentButtonStyle())
            }
        }
    }

    private var phaseText: (String, String) {
        if engine.waitingWifi { return ("wifi.slash", "Ждёт Wi-Fi — включено «Только по Wi-Fi»") }
        if !engine.serverOnline { return ("wifi.exclamationmark", "Нет связи с роутером") }
        if !engine.inflightKeys.isEmpty { return ("paperplane.fill", "Отправляю на SSD · \(engine.inflightKeys.count) в пути") }
        if engine.preparingCount > 0 { return ("icloud.and.arrow.down", "Готовлю файлы (может качаться из iCloud)") }
        return ("hourglass", "Подготовка")
    }

    private func etaText(_ t: TimeInterval) -> String {
        let m = Int(t / 60)
        if m < 1 { return "меньше минуты" }
        if m < 60 { return "≈ \(m) мин" }
        let h = m / 60, rest = m % 60
        if h < 48 { return "≈ \(h) ч \(rest) мин" }
        return "≈ \(h / 24) дн \(h % 24) ч"
    }

    private var syncDetails: some View {
        Panel {
            MonoLabel(text: "Как идёт выгрузка", number: "02")
            HStack(spacing: 10) {
                Image(systemName: phaseText.0).foregroundColor(Theme.acc).frame(width: 22)
                Text(phaseText.1).font(F.sans(14, 500)).foregroundColor(Theme.ink)
            }
            .padding(.top, 12)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 14) {
                DetailCell(label: "Выгружено сейчас", value: "\(engine.sessionUploaded) · \(formatBytes(engine.sessionBytes))")
                DetailCell(label: "Осталось", value: "\(engine.remaining)")
                DetailCell(label: "Скорость", value: engine.speed > 0 ? "\(formatBytes(Int64(engine.speed)))/с" : "—")
                DetailCell(label: "До конца", value: engine.eta.map(etaText) ?? "считаю…")
            }
            .padding(.top, 14)

            if let start = engine.sessionStart {
                Text("запущено \(start.formatted(date: .omitted, time: .shortened)) · открытым — быстрее всего; в свёрнутом виде iOS выгружает порциями, ночью на зарядке — больше всего")
                    .font(F.mono(10)).foregroundColor(Theme.dim).padding(.top, 12)
            }
        }
    }

    private var filesPanel: some View {
        Panel {
            MonoLabel(text: "Сейчас в работе", number: "03")
            VStack(alignment: .leading, spacing: 12) {
                ForEach(engine.files.keys.sorted(), id: \.self) { k in
                    let f = engine.files[k] ?? SyncEngine.FileProgress(name: "", stage: "", fraction: 0)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            Image(systemName: f.stage == "iCloud" ? "icloud.and.arrow.down" : (f.stage == "отправка" ? "paperplane.fill" : "gearshape"))
                                .font(.system(size: 11, weight: .bold)).foregroundColor(Theme.acc).frame(width: 16)
                            Text(f.name).font(F.mono(11)).foregroundColor(Theme.ink).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(f.fraction > 0 ? "\(f.stage) \(Int(f.fraction * 100))%" : f.stage)
                                .font(F.mono(10, 600)).foregroundColor(Theme.acc2)
                        }
                        ProgressBar(value: f.fraction).frame(height: 3)
                    }
                }
            }.padding(.top, 12)
        }
    }

    private var currentPanel: some View {
        Panel {
            MonoLabel(text: "Последние файлы", number: "03")
            VStack(alignment: .leading, spacing: 8) {
                ForEach(engine.currentNames.prefix(4), id: \.self) { name in
                    HStack(spacing: 10) {
                        ProgressView().tint(Theme.acc).scaleEffect(0.7)
                        Text(name).font(F.mono(12)).foregroundColor(Theme.ink).lineLimit(1).truncationMode(.middle)
                    }
                }
            }.padding(.top, 12)
        }
    }

    private var statsGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            StatTile(value: "\(store.done.count)", label: "файлов на SSD")
            StatTile(value: formatBytes(store.totalBytes), label: "объём на SSD")
            StatTile(value: "\(engine.sessionUploaded)", label: "за этот запуск", accent: true)
            StatTile(value: "\(store.failed.count)", label: "с ошибкой", warn: !store.failed.isEmpty)
        }
    }

    private var serverPanel: some View {
        Panel {
            MonoLabel(text: "Хранилище роутера", number: "03")
            if let st = engine.serverStatus, st.total > 0 {
                let used = Double(st.total - st.free) / Double(st.total)
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(formatBytes(st.free)).font(F.display(26, 700)).foregroundColor(Theme.ink)
                        Text("свободно").font(F.sans(14)).foregroundColor(Theme.muted)
                        Spacer()
                        Text("из \(formatBytes(st.total))").font(F.mono(12)).foregroundColor(Theme.muted)
                    }
                    ProgressBar(value: used, color: Theme.muted).frame(height: 5)
                    HStack {
                        Text("сервер v\(st.version)").font(F.mono(11)).foregroundColor(Theme.dim)
                        Spacer()
                        if let last = store.lastSync {
                            Text("последняя выгрузка: \(last.formatted(date: .abbreviated, time: .shortened))")
                                .font(F.mono(11)).foregroundColor(Theme.dim)
                        }
                    }
                }.padding(.top, 12)
            } else {
                Text("Нет данных — проверьте адрес и токен в настройках")
                    .font(F.sans(14)).foregroundColor(Theme.muted).padding(.top, 10)
            }
        }
    }

    private func errorPanel(_ err: String) -> some View {
        Panel {
            MonoLabel(text: "Последняя ошибка", color: Theme.danger)
            Text(err).font(F.sans(14)).foregroundColor(Theme.ink).padding(.top, 8)
        }
    }
}

struct DetailCell: View {
    let label: String, value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(F.mono(9, 500)).tracking(1).foregroundColor(Theme.muted)
            Text(value).font(F.display(16, 700)).foregroundColor(Theme.ink).lineLimit(1).minimumScaleFactor(0.7)
        }
    }
}

// MARK: - Самолётик: летает по карточке, пока идёт выгрузка, и оставляет пунктирный шлейф.

struct PaperPlaneFlight: View {
    private let period: Double = 4.2

    var body: some View {
        TimelineView(.animation) { tl in
            GeometryReader { g in
                let t = tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
                Canvas { ctx, size in
                    // шлейф — несколько точек позади самолётика
                    for i in 1...14 {
                        let tt = t - Double(i) * 0.018
                        guard tt > 0 else { continue }
                        let p = point(tt, size)
                        let r = CGFloat(3.2 - Double(i) * 0.18)
                        ctx.fill(Path(ellipseIn: CGRect(x: p.x - r / 2, y: p.y - r / 2, width: r, height: r)),
                                 with: .color(Theme.acc.opacity(0.55 - Double(i) * 0.035)))
                    }
                }
                let p = point(t, g.size)
                let next = point(min(1, t + 0.01), g.size)
                let angle = atan2(next.y - p.y, next.x - p.x)
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Theme.accGradient)
                    .shadow(color: Theme.acc.opacity(0.7), radius: 8)
                    .rotationEffect(.radians(Double(angle) + .pi / 4))
                    .position(p)
                    .opacity(t < 0.06 ? t / 0.06 : (t > 0.92 ? (1 - t) / 0.08 : 1))
            }
        }
        .allowsHitTesting(false)
    }

    /// Траектория: слева снизу вправо вверх, с волной.
    private func point(_ t: Double, _ size: CGSize) -> CGPoint {
        let x = -20 + (size.width + 40) * t
        let base = size.height * (0.78 - 0.55 * t)
        let wave = sin(t * .pi * 3) * size.height * 0.07
        return CGPoint(x: x, y: base + wave)
    }
}

// MARK: - Анимация «залёта»: оранжевая плашка с именем файла взлетает к логотипу.

struct Flight: Identifiable {
    let id = UUID()
    let name: String
    let start: CGPoint
}

struct FlightLayer: View {
    let trigger: Int
    let name: String
    @State private var flights: [Flight] = []

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                ForEach(flights) { f in
                    FlyingChip(flight: f, target: CGPoint(x: 31, y: 26)) {
                        flights.removeAll { $0.id == f.id }
                    }
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
            .onChange(of: trigger) { _ in
                guard flights.count < 5 else { return }
                let x = CGFloat.random(in: g.size.width * 0.25...g.size.width * 0.75)
                flights.append(Flight(name: name, start: CGPoint(x: x, y: min(g.size.height * 0.55, 420))))
            }
        }
        .allowsHitTesting(false)
    }
}

struct FlyingChip: View {
    let flight: Flight
    let target: CGPoint
    var done: () -> Void
    @State private var progress: CGFloat = 0

    var body: some View {
        let x = flight.start.x + (target.x - flight.start.x) * progress
        // дуга: поднимаемся выше прямой линии
        let lift = sin(progress * .pi) * 60
        let y = flight.start.y + (target.y - flight.start.y) * progress - lift
        HStack(spacing: 6) {
            Image(systemName: "photo.fill").font(.system(size: 10, weight: .bold))
            Text(flight.name).font(F.mono(10, 600)).lineLimit(1)
        }
        .foregroundColor(Theme.bg)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.accGradient)
        .clipShape(Capsule())
        .shadow(color: Theme.acc.opacity(0.6), radius: 10)
        .scaleEffect(1 - progress * 0.75)
        .opacity(progress > 0.85 ? Double((1 - progress) / 0.15) : 1)
        .fixedSize()
        .position(x: x, y: y)
        .onAppear {
            withAnimation(.easeIn(duration: 0.9)) { progress = 1 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.95) { done() }
        }
    }
}

struct StatTile: View {
    let value: String
    let label: String
    var accent = false
    var warn = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value)
                .font(F.display(26, 800))
                .foregroundColor(warn ? Theme.danger : (accent ? Theme.acc : Theme.ink))
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(label.uppercased()).font(F.mono(10, 500)).tracking(1).foregroundColor(Theme.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.panel)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

struct ProgressBar: View {
    var value: Double
    var color: Color? = nil
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.panel2)
                Capsule()
                    .fill(color.map { AnyShapeStyle($0) } ?? AnyShapeStyle(Theme.accGradient))
                    .frame(width: max(0, min(1, value)) * g.size.width)
                    .animation(.easeOut(duration: 0.4), value: value)
            }
        }
    }
}
