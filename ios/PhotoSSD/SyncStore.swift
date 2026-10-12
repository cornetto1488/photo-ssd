import Foundation

/// Локальный журнал выгрузок: какой ресурс какого снимка уже лежит на SSD.
/// Ключ — "<localIdentifier>#<роль>", тот же id уходит на сервер.
struct UploadRecord: Codable {
    var path: String
    var size: Int64
    var date: Date
}

@MainActor
final class SyncStore: ObservableObject {
    static let shared = SyncStore()

    @Published private(set) var done: [String: UploadRecord] = [:]
    @Published private(set) var failed: [String: String] = [:]   // ключ -> текст ошибки
    @Published private(set) var lastSync: Date?

    private let url: URL
    private var saveTask: Task<Void, Never>?

    private struct Snapshot: Codable {
        var done: [String: UploadRecord]
        var failed: [String: String]
        var lastSync: Date?
    }

    private init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("sync-store.json")
        if let data = try? Data(contentsOf: url),
           let snap = try? JSONDecoder().decode(Snapshot.self, from: data) {
            done = snap.done
            failed = snap.failed
            lastSync = snap.lastSync
        }
    }

    nonisolated static func key(_ assetID: String, _ role: ResourceRole) -> String { "\(assetID)#\(role.rawValue)" }
    nonisolated static func assetID(fromKey key: String) -> String { String(key.split(separator: "#").first ?? "") }

    func isDone(_ key: String) -> Bool { done[key] != nil }

    func markDone(_ key: String, path: String, size: Int64) {
        done[key] = UploadRecord(path: path, size: size, date: Date())
        failed[key] = nil
        lastSync = Date()
        scheduleSave()
    }

    func markFailed(_ key: String, _ message: String) {
        failed[key] = message
        scheduleSave()
    }

    func clearFailed() { failed.removeAll(); scheduleSave() }

    /// Сверка с сервером: всё, что сервер уже принял, считаем выгруженным.
    func merge(server: [ServerRecord]) -> Int {
        var added = 0
        for r in server where done[r.id] == nil {
            done[r.id] = UploadRecord(path: r.path, size: r.size, date: Date())
            added += 1
        }
        if added > 0 { scheduleSave() }
        return added
    }

    func reset() {
        done.removeAll(); failed.removeAll(); lastSync = nil
        saveNow()
    }

    /// Какие ассеты выгружены полностью (все нужные роли), чтобы показать в медиатеке.
    var doneAssetIDs: Set<String> { Set(done.keys.map(Self.assetID(fromKey:))) }
    var failedAssetIDs: Set<String> { Set(failed.keys.map(Self.assetID(fromKey:))) }

    var totalBytes: Int64 { done.values.reduce(0) { $0 + $1.size } }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.saveNow()
        }
    }

    func saveNow() {
        let snap = Snapshot(done: done, failed: failed, lastSync: lastSync)
        if let data = try? JSONEncoder().encode(snap) {
            try? data.write(to: url, options: .atomic)
        }
    }
}

// MARK: - Журнал событий

struct LogEntry: Identifiable, Codable {
    enum Level: String, Codable { case info, ok, warn, error }
    var id = UUID()
    var date = Date()
    var level: Level
    var text: String
}

@MainActor
final class LogStore: ObservableObject {
    static let shared = LogStore()
    @Published private(set) var entries: [LogEntry] = []
    private let limit = 500

    func add(_ text: String, _ level: LogEntry.Level = .info) {
        entries.insert(LogEntry(level: level, text: text), at: 0)
        if entries.count > limit { entries.removeLast(entries.count - limit) }
    }

    func clear() { entries.removeAll() }

    var exportText: String {
        let f = DateFormatter()
        f.dateFormat = "dd.MM HH:mm:ss"
        return entries.reversed().map { "\(f.string(from: $0.date)) [\($0.level.rawValue)] \($0.text)" }.joined(separator: "\n")
    }
}
