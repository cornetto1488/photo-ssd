import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Группа приложений: через неё приложение передаёт данные виджету.
enum AppGroup {
    static let id = "group.ru.apodmarchuk.photossd"
    static var defaults: UserDefaults { UserDefaults(suiteName: id) ?? .standard }
}

/// Что показывает виджет.
struct WidgetSnapshot: Codable {
    var done: Int
    var total: Int
    var bytes: Int64
    var online: Bool
    var syncing: Bool
    var lastSync: Date?
    var free: Int64
    var updated: Date

    var percent: Int { total == 0 ? 0 : Int((Double(done) / Double(total) * 100).rounded(.down)) }

    static let placeholder = WidgetSnapshot(done: 1336, total: 1462, bytes: 2_760_000_000, online: true,
                                            syncing: false, lastSync: Date(), free: 230_000_000_000, updated: Date())

    static func read() -> WidgetSnapshot? {
        guard let data = AppGroup.defaults.data(forKey: "widgetSnapshot") else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

#if canImport(ActivityKit)
@available(iOS 16.1, *)
struct ZaletActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var done: Int
        var total: Int
        var speed: Double     // байт/с
        var current: String
        var uploaded: Int
        var finished: Bool
        var bytes: Int64

        var progress: Double { total == 0 ? 0 : min(1, Double(done) / Double(total)) }
    }
    var startedAt: Date
}
#endif
