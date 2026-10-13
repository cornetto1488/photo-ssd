import Foundation
import UIKit
import UserNotifications
import WidgetKit
#if canImport(ActivityKit)
import ActivityKit
#endif

// MARK: - Виджет

@MainActor
enum WidgetBridge {
    private static var lastReload = Date.distantPast

    static func write(_ s: WidgetSnapshot) {
        if let data = try? JSONEncoder().encode(s) {
            AppGroup.defaults.set(data, forKey: "widgetSnapshot")
        }
        // WidgetKit ограничивает частоту обновлений — не дёргаем чаще раза в 30 секунд.
        if Date().timeIntervalSince(lastReload) > 30 || !s.syncing {
            lastReload = Date()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}

// MARK: - Live Activity

@MainActor
enum LiveActivityManager {
    static func start(done: Int, total: Int) {
        #if canImport(ActivityKit)
        guard #available(iOS 16.2, *), AppSettings.shared.liveActivity,
              ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = ZaletActivityAttributes.ContentState(done: done, total: total, speed: 0, current: "",
                                                         uploaded: 0, finished: false, bytes: 0)
        let all = Activity<ZaletActivityAttributes>.activities
        for extra in all.dropFirst() { Task { await extra.end(nil, dismissalPolicy: .immediate) } }
        if let current = all.first {
            Task { await current.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        _ = try? Activity.request(attributes: ZaletActivityAttributes(startedAt: Date()),
                                  content: ActivityContent(state: state, staleDate: nil), pushType: nil)
        #endif
    }

    private static var lastUpdate = Date.distantPast

    static func update(done: Int, total: Int, speed: Double, current: String, uploaded: Int) {
        #if canImport(ActivityKit)
        guard #available(iOS 16.2, *) else { return }
        // не дёргаем экран блокировки и «островок» чаще раза в 15 секунд
        guard Date().timeIntervalSince(lastUpdate) > 15 else { return }
        lastUpdate = Date()
        let state = ZaletActivityAttributes.ContentState(done: done, total: total, speed: speed, current: current,
                                                         uploaded: uploaded, finished: false, bytes: 0)
        let all = Activity<ZaletActivityAttributes>.activities
        // если вдруг накопилось несколько карточек — оставляем одну
        for extra in all.dropFirst() { Task { await extra.end(nil, dismissalPolicy: .immediate) } }
        if let a = all.first {
            Task { await a.update(ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: 120))) }
        }
        #endif
    }

    static func end(done: Int, total: Int, uploaded: Int, bytes: Int64) {
        #if canImport(ActivityKit)
        guard #available(iOS 16.2, *) else { return }
        let state = ZaletActivityAttributes.ContentState(done: done, total: total, speed: 0, current: "",
                                                         uploaded: uploaded, finished: true, bytes: bytes)
        for a in Activity<ZaletActivityAttributes>.activities {
            Task {
                await a.end(ActivityContent(state: state, staleDate: nil),
                            dismissalPolicy: .after(Date(timeIntervalSinceNow: 60)))
            }
        }
        #endif
    }
}

// MARK: - Тактильный отклик

@MainActor
enum Haptics {
    private static var last = Date.distantPast
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let note = UINotificationFeedbackGenerator()

    static func landed() {
        guard AppSettings.shared.haptics, UIApplication.shared.applicationState == .active,
              Date().timeIntervalSince(last) > 0.25 else { return }
        last = Date()
        soft.impactOccurred(intensity: 0.55)
    }

    static func finished() {
        guard AppSettings.shared.haptics, UIApplication.shared.applicationState == .active else { return }
        note.notificationOccurred(.success)
    }

    static func tap() {
        guard AppSettings.shared.haptics else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

// MARK: - «Умная ночь»: утренний отчёт

enum NightReport {
    static let id = "zalet.night.summary"

    static func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Ставит (или обновляет) утреннее уведомление с итогами ночи.
    static func schedule(count: Int, bytes: Int64, hour: Int) {
        guard count > 0 else { return }
        let content = UNMutableNotificationContent()
        content.title = "ZALET"
        content.body = "Залетело \(count) \(plural(count, "файл", "файла", "файлов")), \(formatBytes(bytes)) — всё на SSD"
        content.sound = .default

        var c = DateComponents()
        c.hour = hour
        c.minute = 0
        let trigger = UNCalendarNotificationTrigger(dateMatching: c, repeats: false)
        let req = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(req)
    }

    static func cancel() {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }

    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let n10 = n % 10, n100 = n % 100
        if n10 == 1 && n100 != 11 { return one }
        if (2...4).contains(n10) && !(12...14).contains(n100) { return few }
        return many
    }
}
