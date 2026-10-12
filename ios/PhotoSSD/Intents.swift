import AppIntents

/// Команда для «Команд» и Siri: выгрузить новое, не открывая приложение.
/// Удобно повесить на автоматизацию «Камера закрыта» — снял фото, и оно само улетело на SSD.
struct SyncNowIntent: AppIntent {
    static var title: LocalizedStringResource = "Выгрузить новые фото"
    static var description = IntentDescription("ZALET отправит новые фото и видео на SSD роутера, не открывая приложение.")
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let engine = SyncEngine.shared
        let store = SyncStore.shared
        let before = store.done.count
        engine.start(reason: "команда")
        // iOS даёт команде около 30 секунд: за это время готовим файлы и отдаём их системе.
        // Отданные файлы iOS досылает сама, даже когда команда уже завершилась.
        for _ in 0..<25 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if engine.state == .finished { break }
            if case .error = engine.state { break }
        }
        store.saveNow()
        let landed = store.done.count - before
        let flying = engine.inflightKeys.count
        if case .error(let msg) = engine.state {
            return .result(dialog: "ZALET: \(msg)")
        }
        if landed == 0 && flying == 0 {
            return .result(dialog: "ZALET: всё уже на SSD")
        }
        return .result(dialog: "ZALET: залетело \(landed), ещё \(flying) в пути")
    }
}

struct ZaletShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: SyncNowIntent(), phrases: [
            "Залёт в \(.applicationName)",
            "Выгрузить фото в \(.applicationName)",
            "Отправить фото на SSD в \(.applicationName)"
        ])
    }
}
