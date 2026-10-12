import SwiftUI

struct LogView: View {
    @EnvironmentObject var log: LogStore
    @State private var onlyErrors = false

    private var items: [LogEntry] {
        onlyErrors ? log.entries.filter { $0.level == .error || $0.level == .warn } : log.entries
    }

    var body: some View {
        Group {
            List {
                if items.isEmpty {
                    Text("Пока пусто").font(F.sans(14)).foregroundColor(Theme.muted)
                        .listRowBackground(Theme.bg)
                }
                ForEach(items) { e in
                    HStack(alignment: .top, spacing: 10) {
                        Circle().fill(color(e.level)).frame(width: 7, height: 7).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(e.text).font(F.sans(13)).foregroundColor(Theme.ink)
                            Text(e.date.formatted(date: .omitted, time: .standard)).font(F.mono(10)).foregroundColor(Theme.dim)
                        }
                    }
                    .listRowBackground(Theme.bg)
                    .listRowSeparatorTint(Theme.line)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Журнал")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(onlyErrors ? "Все" : "Ошибки") { onlyErrors.toggle() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        ShareLink(item: log.exportText) { Label("Поделиться журналом", systemImage: "square.and.arrow.up") }
                        Button(role: .destructive) { log.clear() } label: { Label("Очистить", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
    }

    private func color(_ l: LogEntry.Level) -> Color {
        switch l {
        case .info: return Theme.muted
        case .ok: return Theme.live
        case .warn: return Theme.acc
        case .error: return Theme.danger
        }
    }
}

struct OnboardingView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var engine: SyncEngine
    @State private var checking = false
    @State private var result: String?
    @State private var ok = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                MonoLabel(text: "Первый запуск", number: "00").padding(.top, 40)
                VStack(alignment: .leading, spacing: 6) {
                    ZaletWordmark(size: 72)
                    Text("фото залетают на SSD").font(F.mono(14, 500)).foregroundColor(Theme.acc2)
                }
                Text("Выгружает фото и видео с iPhone на SSD роутера. Только новое, без повторов, в фоне — дома и через Tailscale.")
                    .font(F.sans(16)).foregroundColor(Theme.muted)

                Panel {
                    MonoLabel(text: "Адрес сервера", number: "01")
                    TextField("http://192.168.1.1:8099", text: $settings.serverURL)
                        .font(F.mono(15)).foregroundColor(Theme.ink)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .padding(.top, 10)
                    Divider().background(Theme.line).padding(.vertical, 12)
                    MonoLabel(text: "Токен доступа", number: "02")
                    SecureField("вставьте токен", text: $settings.token)
                        .font(F.mono(15)).foregroundColor(Theme.ink)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(.top, 10)
                }

                if let result {
                    HStack(spacing: 8) {
                        Image(systemName: ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundColor(ok ? Theme.live : Theme.danger)
                        Text(result).font(F.sans(14)).foregroundColor(Theme.ink)
                    }
                }

                Button {
                    Task {
                        checking = true
                        ok = await engine.refreshServer()
                        result = ok ? "Роутер на связи, свободно \(formatBytes(engine.serverStatus?.free ?? 0))"
                                    : (engine.lastError ?? "Нет связи")
                        checking = false
                    }
                } label: {
                    if checking { ProgressView().tint(Theme.ink) } else { Text("Проверить подключение") }
                }
                .buttonStyle(AccentButtonStyle(filled: false))

                Button("Продолжить") { settings.onboarded = true }
                    .buttonStyle(AccentButtonStyle())
                    .disabled(!ok)
                    .opacity(ok ? 1 : 0.4)

                Text("Раскладку по папкам, типы файлов и фоновую выгрузку можно настроить позже в «Настройках».")
                    .font(F.sans(13)).foregroundColor(Theme.dim)
            }
            .padding(.horizontal, 20)
        }
        .background(Theme.bg.ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
    }
}
