import SwiftUI
import BackgroundTasks

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        for id in [SyncEngine.refreshTaskID, SyncEngine.processingTaskID] {
            BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { task in
                Task { @MainActor in SyncEngine.shared.handleBackgroundTask(task) }
            }
        }
        Task { @MainActor in _ = SyncEngine.shared }
        return true
    }

    // iOS будит приложение, когда фоновые передачи завершились.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            let engine = SyncEngine.shared
            engine.backgroundCompletionHandlers[identifier] = completionHandler
            _ = engine.session(id: identifier)
            // Пачка ушла — готовим следующую, пока iOS дала время.
            engine.backgroundRefill(reason: "фон: следующая пачка")
        }
    }
}

@main
struct PhotoSSDApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var phase
    @StateObject private var settings = AppSettings.shared
    @StateObject private var engine = SyncEngine.shared
    @StateObject private var store = SyncStore.shared
    @StateObject private var log = LogStore.shared

    init() { applyGlobalAppearance() }

    var body: some Scene {
        WindowGroup {
            Group {
                if settings.onboarded { RootView() } else { OnboardingView() }
            }
            .environmentObject(settings)
            .environmentObject(engine)
            .environmentObject(store)
            .environmentObject(log)
            .preferredColorScheme(.dark)
            .tint(Theme.acc)
        }
        .onChange(of: phase) { p in
            switch p {
            case .active:
                engine.resetNightReport()
                engine.migrateToForeground()
                Task {
                    await engine.refreshServer()
                    if settings.onboarded && settings.autoStart { engine.start(reason: "открытие") }
                }
            case .background:
                engine.migrateToBackground()
                store.saveNow()
                engine.scheduleBackground()
                engine.backgroundRefill(reason: "свёрнуто")
            default: break
            }
        }
    }
}
