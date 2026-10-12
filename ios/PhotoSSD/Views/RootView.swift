import SwiftUI

struct RootView: View {
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            HomeView()
                .tabItem { Label("Главная", systemImage: "arrow.up.circle.fill") }.tag(0)
            LibraryView()
                .tabItem { Label("Медиатека", systemImage: "square.grid.3x3.fill") }.tag(1)
            LogView()
                .tabItem { Label("Журнал", systemImage: "list.bullet.rectangle") }.tag(2)
            SettingsView()
                .tabItem { Label("Настройки", systemImage: "slider.horizontal.3") }.tag(3)
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
                    if !engine.currentNames.isEmpty && isBusy { currentPanel }
                    statsGrid
                    serverPanel
                    if let err = engine.lastError, !isBusy { errorPanel(err) }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(Theme.bg.ignoresSafeArea())
            .refreshable { await engine.refreshServer() }
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var header: some View {
        HStack {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 8).fill(Theme.accGradient).frame(width: 30, height: 30)
                    .overlay(Image(systemName: "arrow.down.to.line").font(.system(size: 14, weight: .black)).foregroundColor(Theme.bg))
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
            MonoLabel(text: engine.state.title, number: "01")
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

    private var currentPanel: some View {
        Panel {
            MonoLabel(text: "Сейчас отправляется", number: "02")
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
