import Foundation
import Photos
import UIKit
import ImageIO
import UniformTypeIdentifiers
import BackgroundTasks
import Network

struct ExportStalled: LocalizedError {
    var errorDescription: String? { "файл слишком долго качается из iCloud" }
}

/// Следит за экспортом из медиатеки: последний момент активности и однократное завершение.
final class ExportGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    private var fired = false
    func touch() { lock.lock(); last = Date(); lock.unlock() }
    var idleSeconds: TimeInterval { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(last) }
    var isFired: Bool { lock.lock(); defer { lock.unlock() }; return fired }
    /// true только при первом вызове.
    func fire() -> Bool { lock.lock(); defer { lock.unlock() }; if fired { return false }; fired = true; return true }
}

/// Что нужно выгрузить: конкретная часть конкретного снимка.
struct PendingRef: Hashable, Sendable {
    let key: String
    let assetID: String
    let role: ResourceRole
}

/// Метаданные задачи передачи — живут в taskDescription, чтобы пережить перезапуск приложения.
struct TaskMeta: Codable {
    let key: String
    let path: String
    let tmp: String
    let size: Int64
    let name: String
}

struct ScanConfig: Sendable {
    var albumID: String
    var includePhotos: Bool
    var includeLive: Bool
    var includeVideos: Bool
    var includeScreenshots: Bool
    var includeHidden: Bool
    var allBursts: Bool
    var versionMode: VersionMode
    var since: Date?
}

enum SyncState: Equatable {
    case idle, checking, scanning, syncing, paused, finished
    case error(String)

    var title: String {
        switch self {
        case .idle: return "Готово к синхронизации"
        case .checking: return "Проверка сервера"
        case .scanning: return "Сканирую медиатеку"
        case .syncing: return "Идёт выгрузка"
        case .paused: return "Пауза"
        case .finished: return "Всё выгружено"
        case .error(let m): return m
        }
    }
}

@MainActor
final class SyncEngine: NSObject, ObservableObject {
    static let shared = SyncEngine()

    static let refreshTaskID = "ru.apodmarchuk.photossd.refresh"
    static let processingTaskID = "ru.apodmarchuk.photossd.processing"
    static let sessionWifi = "ru.apodmarchuk.photossd.bg.wifi"
    static let sessionAny = "ru.apodmarchuk.photossd.bg.any"

    // Состояние для интерфейса
    @Published private(set) var state: SyncState = .idle
    @Published private(set) var serverOnline = false
    @Published private(set) var serverStatus: ServerStatus?
    @Published private(set) var totalInScope = 0       // сколько частей должно быть на SSD
    @Published private(set) var doneInScope = 0        // сколько из них уже там
    @Published private(set) var sessionUploaded = 0    // выгружено за этот запуск
    @Published private(set) var sessionBytes: Int64 = 0
    @Published private(set) var currentNames: [String] = []
    @Published private(set) var speed: Double = 0      // байт/с
    @Published private(set) var queuedKeys: Set<String> = []
    @Published private(set) var inflightKeys: Set<String> = []
    @Published private(set) var lastError: String?
    @Published fileprivate(set) var scanProgress: Double = 0
    @Published private(set) var preparingCount = 0      // сколько файлов сейчас готовится (экспорт/iCloud)
    @Published private(set) var sessionStart: Date?
    @Published private(set) var sessionPending = 0      // сколько было в очереди в начале запуска

    /// Примерное время до конца, по средней скорости за этот запуск.
    var eta: TimeInterval? {
        guard let start = sessionStart, sessionUploaded >= 3 else { return nil }
        let elapsed = Date().timeIntervalSince(start)
        let perFile = elapsed / Double(sessionUploaded)
        let left = max(0, totalInScope - doneInScope)
        return perFile * Double(left)
    }

    var remaining: Int { max(0, totalInScope - doneInScope) }
    @Published private(set) var waitingWifi = false
    @Published private(set) var landed = 0             // счётчик для анимации «залёта»
    @Published private(set) var lastLandedName = ""

    // «Умная ночь»: итоги ночных выгрузок для утреннего уведомления
    private var isNightRun = false
    private var nightCount: Int {
        get { UserDefaults.standard.integer(forKey: "nightCount") }
        set { UserDefaults.standard.set(newValue, forKey: "nightCount") }
    }
    private var nightBytes: Int64 {
        get { Int64(UserDefaults.standard.double(forKey: "nightBytes")) }
        set { UserDefaults.standard.set(Double(newValue), forKey: "nightBytes") }
    }
    private var lastPublish = Date.distantPast

    private var queue: [PendingRef] = []
    private var running = false
    private var exporting = 0
    private var responseData: [String: Data] = [:]
    private var bytesWindow: [(Date, Int64)] = []
    private var sessions: [String: URLSession] = [:]
    var backgroundCompletionHandlers: [String: () -> Void] = [:]
    private var pendingAlbumIDs: [String] = []

    private let settings = AppSettings.shared
    private let store = SyncStore.shared
    private let log = LogStore.shared

    private var tmpDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    override private init() {
        super.init()
        // Поднимаем обе фоновые сессии, чтобы получить события по задачам прошлых запусков.
        _ = session(id: Self.sessionWifi)
        _ = session(id: Self.sessionAny)
        PHPhotoLibrary.shared().register(self)
        restoreInflight()
        pathMonitor.pathUpdateHandler = { path in
            let wifi = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            let kind = path.status != .satisfied ? "нет сети" : (wifi ? "Wi-Fi" : (path.usesInterfaceType(.cellular) ? "LTE" : "другая"))
            Task { @MainActor in
                SyncEngine.shared.netUp = path.status == .satisfied
                SyncEngine.shared.onWifiChange(wifi)
                SyncEngine.shared.onNetworkChange(kind: kind)
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "zalet.path"))
    }

    private let pathMonitor = NWPathMonitor()
    private(set) var onWifi = true

    private(set) var netUp = true

    fileprivate func onWifiChange(_ wifi: Bool) {
        onWifi = wifi
        waitingWifi = settings.wifiOnly && !wifi
    }

    /// Пересчитать после смены настройки «Только по Wi-Fi».
    func refreshWifiWait() { waitingWifi = settings.wifiOnly && !onWifi }

    // MARK: Сессии

    func session(id: String) -> URLSession {
        if let s = sessions[id] { return s }
        let c = URLSessionConfiguration.background(withIdentifier: id)
        c.allowsCellularAccess = (id == Self.sessionAny)
        c.sessionSendsLaunchEvents = true
        c.isDiscretionary = false
        c.httpMaximumConnectionsPerHost = 4
        c.timeoutIntervalForResource = 60 * 60 * 24
        let s = URLSession(configuration: c, delegate: self, delegateQueue: nil)
        sessions[id] = s
        return s
    }

    private var activeSession: URLSession {
        session(id: settings.wifiOnly ? Self.sessionWifi : Self.sessionAny)
    }

    /// Обычная (быстрая) сессия — пока приложение открыто. iOS не притормаживает её, в отличие от фоновой.
    private lazy var fgSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 60 * 60 * 6
        c.waitsForConnectivity = true
        c.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()

    struct FgTask {
        let task: URLSessionUploadTask
        let request: URLRequest
        let tmp: URL
        let key: String
    }
    private var fgTasks: [Int: FgTask] = [:]
    private var migrating: Set<Int> = []
    private var lastProgressAt: [Int: Date] = [:]
    private var retries: [String: Int] = [:]
    private var watchdog: Task<Void, Never>?

    /// Прогресс по каждому файлу для экрана.
    struct FileProgress: Equatable {
        var name: String
        var stage: String     // "iCloud", "подготовка", "отправка"
        var fraction: Double
    }
    @Published private(set) var files: [String: FileProgress] = [:]

    private func setFile(_ key: String, _ name: String, _ stage: String, _ fraction: Double) {
        files[key] = FileProgress(name: name, stage: stage, fraction: fraction)
    }

    /// Пока приложение свёрнуто, iOS даёт ~30 секунд: готовим пачку файлов и отдаём её на фоновую передачу.
    /// Когда пачка уйдёт, iOS разбудит приложение — и мы приготовим следующую.
    func backgroundRefill(reason: String) {
        guard settings.onboarded, state != .paused,
              settings.backgroundEnabled || settings.smartNight || running else { return }
        var bgID: UIBackgroundTaskIdentifier = .invalid
        bgID = UIApplication.shared.beginBackgroundTask(withName: "zalet.refill") {
            Task { @MainActor in
                SyncEngine.shared.store.saveNow()
                UIApplication.shared.endBackgroundTask(bgID)
            }
        }
        refillActive = true
        if running { pump() } else { start(reason: reason) }
        Task {
            // Используем почти всё выделенное время, потом корректно завершаемся.
            for _ in 0..<26 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if UIApplication.shared.applicationState == .active { break }
                if !self.running && self.exporting == 0 { break }
                if UIApplication.shared.backgroundTimeRemaining < 4 { break }
            }
            self.store.saveNow()
            self.refillActive = false
            // Теперь можно сообщить iOS, что события фоновой сессии обработаны.
            let handlers = self.backgroundCompletionHandlers
            self.backgroundCompletionHandlers.removeAll()
            handlers.values.forEach { $0() }
            if bgID != .invalid { UIApplication.shared.endBackgroundTask(bgID) }
        }
    }
    private var refillActive = false

    /// При сворачивании переносим незавершённые быстрые передачи в фоновую сессию.
    func migrateToBackground() {
        guard !fgTasks.isEmpty else { return }
        let bg = activeSession
        for (id, t) in fgTasks {
            migrating.insert(id)
            t.task.cancel()
            var req = t.request
            req.allowsCellularAccess = !settings.wifiOnly
            let nt = bg.uploadTask(with: req, fromFile: t.tmp)
            nt.taskDescription = t.task.taskDescription
            nt.resume()
        }
        log.add("Передачи перенесены в фон: \(fgTasks.count)")
        fgTasks.removeAll()
        lastProgressAt.removeAll()
    }

    /// Перезапускает «застывшие» передачи: нет движения 90 секунд — отменяем и ставим в очередь заново.
    private func startWatchdog() {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, self.running, self.netUp else { continue }
                let now = Date()
                for (id, t) in self.fgTasks {
                    let last = self.lastProgressAt[id] ?? now
                    if now.timeIntervalSince(last) > 90 {
                        self.log.add("Передача застыла, перезапускаю: \(self.files[t.key]?.name ?? "файл")", .warn)
                        t.task.cancel() // handleComplete вернёт файл в очередь
                    }
                }
            }
        }
    }

    private func restoreInflight() {
        for s in sessions.values {
            s.getAllTasks { tasks in
                Task { @MainActor in
                    for t in tasks where t.state == .running || t.state == .suspended {
                        if let meta = Self.meta(of: t) { self.inflightKeys.insert(meta.key) }
                    }
                }
            }
        }
    }

    nonisolated static func meta(of task: URLSessionTask) -> TaskMeta? {
        guard let s = task.taskDescription, let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TaskMeta.self, from: d)
    }

    // MARK: Сервер

    @discardableResult
    func refreshServer() async -> Bool {
        do {
            let st = try await ServerAPI.ping()
            serverStatus = st
            serverOnline = true
            return true
        } catch {
            serverOnline = false
            lastError = error.localizedDescription
            return false
        }
    }

    // MARK: Запуск

    func start(reason: String = "вручную") {
        guard !running else { return }
        running = true
        lastError = nil
        sessionUploaded = 0
        sessionBytes = 0
        Task { await run(reason: reason) }
    }

    func pause() {
        running = false
        queue.removeAll()
        queuedKeys.removeAll()
        state = .paused
        log.add("Синхронизация на паузе")
    }

    /// Остановить и отменить передачи, которые уже идут.
    func stopAll() {
        pause()
        for s in sessions.values { s.getAllTasks { $0.forEach { $0.cancel() } } }
        for t in fgTasks.values { t.task.cancel() }
        for r in readyQueue { try? FileManager.default.removeItem(at: r.tmp) }
        readyQueue.removeAll()
        files.removeAll()
    }

    private func run(reason: String) async {
        state = .checking
        guard await ensurePhotoAccess() else {
            state = .error("Нет доступа к медиатеке")
            running = false
            return
        }
        guard await refreshServer() else {
            state = .error("Сервер недоступен")
            log.add("Сервер недоступен: \(lastError ?? "")", .error)
            running = false
            return
        }
        // Сверка с журналом роутера — чтобы не выгружать повторно.
        if let items = try? await ServerAPI.index() {
            let added = store.merge(server: items)
            if added > 0 { log.add("Сверка с роутером: \(added) уже было на SSD", .ok) }
        }

        state = .scanning
        scanProgress = 0
        let cfg = scanConfig()
        let result = await Self.scan(cfg) { p in
            Task { @MainActor in SyncEngine.shared.scanProgress = p }
        }
        scanProgress = 1
        let doneKeys = Set(store.done.keys)
        let readyKeys = Set(readyQueue.map(\.key))
        let pending = result.filter { !doneKeys.contains($0.key) && !inflightKeys.contains($0.key) && !readyKeys.contains($0.key) }

        totalInScope = result.count
        doneInScope = result.count - pending.count - inflightKeys.count
        queue = pending
        queuedKeys = Set(pending.map(\.key))
        log.add("Запуск (\(reason)): к выгрузке \(pending.count) из \(result.count)")

        guard running else { return }
        if pending.isEmpty && inflightKeys.isEmpty {
            finish()
            return
        }
        state = .syncing
        sessionStart = Date()
        retries.removeAll()
        startWatchdog()
        if UIApplication.shared.applicationState == .active { migrateToForeground() }
        sessionPending = pending.count
        if UIApplication.shared.applicationState == .active {
            LiveActivityManager.start(done: doneInScope, total: totalInScope)
        }
        publishProgress(force: true)
        pump()
    }

    private func finish() {
        running = false
        state = .finished
        watchdog?.cancel()
        files.removeAll()
        store.saveNow()
        flushAlbum()
        if sessionUploaded > 0 {
            log.add("Готово: выгружено \(sessionUploaded), \(formatBytes(sessionBytes))", .ok)
            Haptics.finished()
        }
        publishProgress(force: true)
        LiveActivityManager.end(done: doneInScope, total: totalInScope, uploaded: sessionUploaded, bytes: sessionBytes)
    }

    /// Обновить виджет и Live Activity (не чаще раза в 2 секунды).
    func publishProgress(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastPublish) > 2 else { return }
        lastPublish = Date()
        let total = max(totalInScope, store.done.count)
        let done = totalInScope > 0 ? doneInScope : store.done.count
        WidgetBridge.write(WidgetSnapshot(done: done, total: total, bytes: store.totalBytes,
                                          online: serverOnline, syncing: state == .syncing,
                                          lastSync: store.lastSync, free: serverStatus?.free ?? 0, updated: Date()))
        if state == .syncing {
            LiveActivityManager.update(done: doneInScope, total: totalInScope, speed: speed,
                                       current: currentNames.first ?? "", uploaded: sessionUploaded)
        }
    }

    func resetNightReport() {
        nightCount = 0
        nightBytes = 0
    }

    /// Отправить на роутер превью снимка (для просмотра SSD в приложении).
    private func sendThumb(forKey key: String) {
        guard let role = key.split(separator: "#").last.flatMap({ ResourceRole(rawValue: String($0)) }),
              role == .photo || role == .video else { return }
        let assetID = SyncStore.assetID(fromKey: key)
        Task {
            guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject,
                  let data = await ThumbLoader.libraryThumb(asset) else { return }
            await ServerAPI.uploadThumb(data, id: key)
        }
    }

    private func scanConfig() -> ScanConfig {
        ScanConfig(albumID: settings.albumID,
                   includePhotos: settings.includePhotos,
                   includeLive: settings.includeLive,
                   includeVideos: settings.includeVideos,
                   includeScreenshots: settings.includeScreenshots,
                   includeHidden: settings.includeHidden,
                   allBursts: settings.burstMode == .all,
                   versionMode: settings.versionMode,
                   since: settings.sinceEnabled ? settings.sinceDate : nil)
    }

    private func ensurePhotoAccess() async -> Bool {
        let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if st == .authorized || st == .limited { return true }
        if st == .notDetermined {
            let res = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            return res == .authorized || res == .limited
        }
        return false
    }

    // MARK: Сканирование

    nonisolated static func fetchAssets(_ cfg: ScanConfig) -> PHFetchResult<PHAsset> {
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.includeHiddenAssets = cfg.includeHidden
        opts.includeAllBurstAssets = cfg.allBursts
        if let since = cfg.since {
            opts.predicate = NSPredicate(format: "creationDate >= %@", since as NSDate)
        }
        if !cfg.albumID.isEmpty,
           let col = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [cfg.albumID], options: nil).firstObject {
            return PHAsset.fetchAssets(in: col, options: opts)
        }
        return PHAsset.fetchAssets(with: opts)
    }

    nonisolated static func kind(of a: PHAsset) -> MediaKind {
        if a.mediaType == .video { return .video }
        if a.mediaSubtypes.contains(.photoScreenshot) { return .screenshot }
        if a.mediaSubtypes.contains(.photoLive) { return .live }
        return .photo
    }

    /// Какие части ассета нужно выгрузить при текущих настройках.
    nonisolated static func roles(for a: PHAsset, _ cfg: ScanConfig) -> [ResourceRole] {
        let k = kind(of: a)
        switch k {
        case .video: guard cfg.includeVideos else { return [] }
        case .screenshot: guard cfg.includeScreenshots else { return [] }
        case .photo, .live: guard cfg.includePhotos else { return [] }
        }
        // Быстрый путь: для оригиналов состав снимка ясен по его типу — без медленного запроса ресурсов.
        if cfg.versionMode == .original {
            if a.mediaType == .video { return [.video] }
            return (k == .live && cfg.includeLive) ? [.photo, .liveVideo] : [.photo]
        }
        let res = PHAssetResource.assetResources(for: a)
        let types = Set(res.map(\.type))
        var out: [ResourceRole] = []

        if a.mediaType == .video {
            let edited = types.contains(.fullSizeVideo)
            switch cfg.versionMode {
            case .original: out.append(.video)
            case .edited: out.append(edited ? .videoEdited : .video)
            case .both: out.append(.video); if edited { out.append(.videoEdited) }
            }
            return out
        }

        let edited = types.contains(.fullSizePhoto)
        switch cfg.versionMode {
        case .original: out.append(.photo)
        case .edited: out.append(edited ? .photoEdited : .photo)
        case .both: out.append(.photo); if edited { out.append(.photoEdited) }
        }
        if k == .live && cfg.includeLive && types.contains(.pairedVideo) {
            let editedLive = types.contains(.fullSizePairedVideo)
            switch cfg.versionMode {
            case .original: out.append(.liveVideo)
            case .edited: out.append(editedLive ? .liveVideoEdited : .liveVideo)
            case .both: out.append(.liveVideo); if editedLive { out.append(.liveVideoEdited) }
            }
        }
        return out
    }

    nonisolated static func scan(_ cfg: ScanConfig, progress: (@Sendable (Double) -> Void)? = nil) async -> [PendingRef] {
        await Task.detached(priority: .userInitiated) {
            let assets = fetchAssets(cfg)
            let total = max(1, assets.count)
            var out: [PendingRef] = []
            out.reserveCapacity(assets.count)
            assets.enumerateObjects { a, i, _ in
                for r in roles(for: a, cfg) {
                    out.append(PendingRef(key: SyncStore.key(a.localIdentifier, r), assetID: a.localIdentifier, role: r))
                }
                if i % 300 == 0 { progress?(Double(i) / Double(total)) }
            }
            return out
        }.value
    }

    // MARK: Конвейер

    private func pump() {
        guard running else { return }
        let limit = max(1, min(6, settings.maxConcurrent))
        let active = UIApplication.shared.applicationState == .active
        // В фоне готовим файлы по 2 за раз и отдаём системе пачкой (до 40 в очереди iOS).
        func canStart() -> Bool {
            active ? (inflightKeys.count + exporting) < limit : (exporting < 2 && inflightKeys.count < 40)
        }
        while running && canStart() && (!readyQueue.isEmpty || !queue.isEmpty) {
            // Сначала — уже подготовленные файлы (после сбоя сети, застывания, возврата из фона).
            if !readyQueue.isEmpty {
                startUpload(readyQueue.removeFirst())
                continue
            }
            let ref = queue.removeFirst()
            exporting += 1
            preparingCount = exporting
            Task { await self.prepareAndUpload(ref) }
        }
        if queue.isEmpty && readyQueue.isEmpty && inflightKeys.isEmpty && exporting == 0 && state == .syncing {
            finish()
        }
    }

    /// Готовый к отправке файл: запрос + временная копия. Переживает перезапуск передачи без повторного экспорта.
    struct ReadyUpload {
        let key: String
        let request: URLRequest
        let tmp: URL
        let desc: String?
        let name: String
    }
    private var readyQueue: [ReadyUpload] = []
    private var migratingBg: Set<String> = []
    private var lastNetChange = Date.distantPast
    private var lastNetKind = ""

    private func startUpload(_ r: ReadyUpload) {
        guard FileManager.default.fileExists(atPath: r.tmp.path) else {
            queue.append(PendingRef(key: r.key, assetID: SyncStore.assetID(fromKey: r.key),
                                    role: r.key.split(separator: "#").last.flatMap { ResourceRole(rawValue: String($0)) } ?? .photo))
            return
        }
        let useFg = UIApplication.shared.applicationState == .active
        var req = r.request
        req.allowsCellularAccess = !settings.wifiOnly   // старые задачи могли помнить «только Wi-Fi»
        let task = (useFg ? fgSession : activeSession).uploadTask(with: req, fromFile: r.tmp)
        task.taskDescription = r.desc
        inflightKeys.insert(r.key)
        if useFg {
            fgTasks[task.taskIdentifier] = FgTask(task: task, request: req, tmp: r.tmp, key: r.key)
            lastProgressAt[task.taskIdentifier] = Date()
        }
        setFile(r.key, r.name, "отправка", 0)
        task.resume()
    }

    /// Открыли приложение: забираем передачи из медленной фоновой сессии iOS в быструю.
    func migrateToForeground() {
        guard running else { return }
        for s in sessions.values {
            s.getAllTasks { tasks in
                Task { @MainActor in
                    let e = SyncEngine.shared
                    var moved = 0
                    for t in tasks where t.state == .running || t.state == .suspended {
                        guard let meta = Self.meta(of: t), let req = t.originalRequest else { continue }
                        let tmp = e.tmpDir.appendingPathComponent(meta.tmp)
                        guard FileManager.default.fileExists(atPath: tmp.path) else { continue }
                        e.migratingBg.insert(meta.key)
                        t.cancel()
                        e.inflightKeys.remove(meta.key)
                        e.readyQueue.append(ReadyUpload(key: meta.key, request: req, tmp: tmp, desc: t.taskDescription, name: meta.name))
                        moved += 1
                    }
                    if moved > 0 { e.log.add("Из фона в быструю передачу: \(moved)") }
                    e.pump()
                }
            }
        }
    }

    /// Сменилась сеть (LTE ↔ Wi-Fi): старые соединения мертвы — сразу перезапускаем передачи.
    fileprivate func onNetworkChange(kind: String) {
        defer { lastNetKind = kind }
        guard !lastNetKind.isEmpty, kind != lastNetKind, running,
              UIApplication.shared.applicationState == .active, !fgTasks.isEmpty else { return }
        lastNetChange = Date()
        log.add("Сеть сменилась (\(lastNetKind) → \(kind)), перезапускаю передачи: \(fgTasks.count)", .warn)
        for t in fgTasks.values { t.task.cancel() }
    }

    nonisolated static func resourceType(for role: ResourceRole) -> PHAssetResourceType {
        switch role {
        case .photo: return .photo
        case .photoEdited: return .fullSizePhoto
        case .liveVideo: return .pairedVideo
        case .liveVideoEdited: return .fullSizePairedVideo
        case .video: return .video
        case .videoEdited: return .fullSizeVideo
        }
    }

    private func albumName(for asset: PHAsset) -> String? {
        let opts = PHFetchOptions()
        let cols = PHAssetCollection.fetchAssetCollectionsContaining(asset, with: .album, options: opts)
        return cols.firstObject?.localizedTitle
    }

    private func prepareAndUpload(_ ref: PendingRef) async {
        defer {
            exporting -= 1
            preparingCount = exporting
            queuedKeys.remove(ref.key)
            if !inflightKeys.contains(ref.key) && !readyQueue.contains(where: { $0.key == ref.key }) { files[ref.key] = nil }
            pump()
        }
        guard running else { return }
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ref.assetID], options: nil).firstObject else {
            store.markFailed(ref.key, "Снимок удалён из медиатеки")
            return
        }
        let resources = PHAssetResource.assetResources(for: asset)
        let wanted = Self.resourceType(for: ref.role)
        guard let res = resources.first(where: { $0.type == wanted })
                ?? (ref.role == .photo ? resources.first(where: { $0.type == .alternatePhoto || $0.type == .fullSizePhoto }) : nil)
        else {
            store.markFailed(ref.key, "Не найден нужный файл в медиатеке")
            return
        }
        let photoName = resources.first(where: { $0.type == .photo })?.originalFilename

        let info = MediaInfo(date: asset.creationDate ?? Date(),
                             kind: Self.kind(of: asset),
                             album: albumName(for: asset),
                             originalFilename: res.originalFilename,
                             role: ref.role,
                             photoFilename: photoName)
        let relPath = Layout.relativePath(for: info)
        currentNames.insert((relPath as NSString).lastPathComponent, at: 0)
        if currentNames.count > 6 { currentNames.removeLast() }

        // 1. Экспорт во временный файл (только этот один файл, не вся медиатека).
        let ext = (res.originalFilename as NSString).pathExtension
        let shownName = (relPath as NSString).lastPathComponent
        var tmp = tmpDir.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : ".\(ext)"))
        setFile(ref.key, shownName, "подготовка", 0)
        do {
            let key = ref.key
            try await Self.export(res, to: tmp, network: settings.allowICloudDownload) { p in
                Task { @MainActor in
                    let e = SyncEngine.shared
                    if e.files[key] != nil { e.setFile(key, shownName, "iCloud", p) }
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            files[ref.key] = nil
            if error is ExportStalled, requeue(ref, reason: "долго качается из iCloud, попробую позже") { return }
            store.markFailed(ref.key, "Экспорт: \(error.localizedDescription)")
            log.add("Не удалось подготовить \(res.originalFilename): \(error.localizedDescription)", .warn)
            return
        }

        // 2. Конвертация HEIC -> JPEG, если включена.
        if settings.photoFormat == .jpeg, ref.role == .photo || ref.role == .photoEdited,
           ["heic", "heif"].contains(ext.lowercased()) {
            let jpg = tmpDir.appendingPathComponent(UUID().uuidString + ".jpg")
            if Self.convertToJPEG(from: tmp, to: jpg, quality: settings.jpegQuality) {
                try? FileManager.default.removeItem(at: tmp)
                tmp = jpg
            }
        }

        let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard running else { try? FileManager.default.removeItem(at: tmp); return }

        // 3. Передача: открыто приложение — быстрая сессия, свёрнуто — фоновая.
        do {
            let kindParam = (ref.role == .liveVideo || ref.role == .liveVideoEdited) ? "livevideo" : info.kind.rawValue
            var req = try ServerAPI.uploadRequest(path: relPath, id: ref.key, size: size, mtime: info.date,
                                                  kind: kindParam, album: info.album)
            req.allowsCellularAccess = !settings.wifiOnly
            let meta = TaskMeta(key: ref.key, path: relPath, tmp: tmp.lastPathComponent, size: size, name: shownName)
            let desc = String(data: (try? JSONEncoder().encode(meta)) ?? Data(), encoding: .utf8)
            startUpload(ReadyUpload(key: ref.key, request: req, tmp: tmp, desc: desc, name: shownName))
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            files[ref.key] = nil
            store.markFailed(ref.key, error.localizedDescription)
        }
    }

    /// Вернуть файл в конец очереди (не больше 3 раз). false — попытки кончились.
    @discardableResult
    private func requeue(_ ref: PendingRef, reason: String) -> Bool {
        let n = (retries[ref.key] ?? 0) + 1
        retries[ref.key] = n
        guard running, n <= 3 else { return false }
        queue.append(ref)
        queuedKeys.insert(ref.key)
        log.add("\(files[ref.key]?.name ?? "Файл"): \(reason) (попытка \(n)/3)", .warn)
        return true
    }

    nonisolated static func export(_ res: PHAssetResource, to url: URL, network: Bool,
                                   progress: @escaping @Sendable (Double) -> Void) async throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let fh = try FileHandle(forWritingTo: url)
        let guardBox = ExportGuard()
        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = network
        opts.progressHandler = { p in guardBox.touch(); progress(p) }
        let mgr = PHAssetResourceManager.default()

        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            let id = mgr.requestData(for: res, options: opts, dataReceivedHandler: { data in
                guardBox.touch()
                try? fh.write(contentsOf: data)
            }, completionHandler: { err in
                try? fh.close()
                guard guardBox.fire() else { return }
                if let err { c.resume(throwing: err) } else { c.resume() }
            })
            // Сторож: 2 минуты без данных — отменяем, файл уйдёт в конец очереди.
            func check() {
                DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                    guard !guardBox.isFired else { return }
                    if guardBox.idleSeconds > 120 {
                        guard guardBox.fire() else { return }
                        mgr.cancelDataRequest(id)
                        try? fh.close()
                        c.resume(throwing: ExportStalled())
                    } else { check() }
                }
            }
            check()
        }
    }

    nonisolated static func convertToJPEG(from src: URL, to dst: URL, quality: Double) -> Bool {
        guard let source = CGImageSourceCreateWithURL(src as CFURL, nil),
              let dest = CGImageDestinationCreateWithURL(dst as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return false }
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImageFromSource(dest, source, 0, props as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }

    // MARK: Результаты передачи

    fileprivate func handleData(key: String, data: Data) {
        responseData[key, default: Data()].append(data)
    }

    fileprivate func handleSent(_ bytes: Int64, key: String?, taskID: Int, isFg: Bool, sent: Int64, expected: Int64) {
        let now = Date()
        bytesWindow.append((now, bytes))
        bytesWindow.removeAll { now.timeIntervalSince($0.0) > 5 }
        let sum = bytesWindow.reduce(Int64(0)) { $0 + $1.1 }
        speed = Double(sum) / 5
        if isFg { lastProgressAt[taskID] = now }
        if let key, var f = files[key], expected > 0 {
            f.stage = "отправка"
            f.fraction = Double(sent) / Double(expected)
            files[key] = f
        }
    }

    fileprivate func handleComplete(meta: TaskMeta?, taskID: Int, isFg: Bool, status: Int, error: Error?,
                                    request: URLRequest?, desc: String?) {
        guard let meta else { return }
        // Задача перенесена в фоновую сессию — файл и учёт не трогаем.
        if isFg && migrating.contains(taskID) {
            migrating.remove(taskID)
            return
        }
        // Задача забрана из фоновой сессии в быструю — уже стоит в очереди готовых.
        if !isFg && migratingBg.contains(meta.key) {
            migratingBg.remove(meta.key)
            return
        }
        let data = responseData.removeValue(forKey: meta.key) ?? Data()
        if isFg { fgTasks[taskID] = nil; lastProgressAt[taskID] = nil }
        inflightKeys.remove(meta.key)
        files[meta.key] = nil
        let tmpURL = tmpDir.appendingPathComponent(meta.tmp)
        let ref = PendingRef(key: meta.key, assetID: SyncStore.assetID(fromKey: meta.key),
                             role: meta.key.split(separator: "#").last.flatMap { ResourceRole(rawValue: String($0)) } ?? .photo)

        if let error {
            let ns = error as NSError
            // Сбой из-за смены сети не считаем попыткой.
            let netSwitch = Date().timeIntervalSince(lastNetChange) < 10
            let n = netSwitch ? (retries[meta.key] ?? 0) : (retries[meta.key] ?? 0) + 1
            retries[meta.key] = n
            if running, n <= 4, let request, FileManager.default.fileExists(atPath: tmpURL.path) {
                // Повторяем отправку с той же временной копией — без нового экспорта.
                readyQueue.append(ReadyUpload(key: meta.key, request: request, tmp: tmpURL, desc: desc, name: meta.name))
                if !netSwitch {
                    log.add("\(meta.name): \(ns.code == NSURLErrorCancelled ? "передача застыла" : error.localizedDescription), повторяю (\(n)/4)", .warn)
                }
            } else {
                try? FileManager.default.removeItem(at: tmpURL)
                if running {
                    store.markFailed(meta.key, error.localizedDescription)
                    log.add("Ошибка \(meta.name): \(error.localizedDescription)", .error)
                    lastError = error.localizedDescription
                }
            }
        } else if (200..<300).contains(status) {
            try? FileManager.default.removeItem(at: tmpURL)
            retries[meta.key] = nil
            let resp = try? JSONDecoder().decode(UploadResponse.self, from: data)
            store.markDone(meta.key, path: resp?.path ?? meta.path, size: resp?.size ?? meta.size)
            doneInScope += 1
            sessionUploaded += 1
            sessionBytes += meta.size
            switch resp?.status {
            case "duplicate", "existing": log.add("Уже на SSD: \(meta.name)", .info)
            default: log.add("Выгружено: \(meta.name) · \(formatBytes(meta.size))", .ok)
            }
            if settings.addToAlbum { pendingAlbumIDs.append(SyncStore.assetID(fromKey: meta.key)) }
            if pendingAlbumIDs.count >= 50 { flushAlbum() }
            if resp?.status != "duplicate" { sendThumb(forKey: meta.key) }
            landed += 1
            lastLandedName = meta.name
            Haptics.landed()
            if UIApplication.shared.applicationState != .active {
                // выгрузки в фоне копим для утреннего отчёта
                nightCount += 1
                nightBytes += meta.size
                if settings.smartNight { NightReport.schedule(count: nightCount, bytes: nightBytes, hour: settings.morningHour) }
            }
            publishProgress()
        } else {
            try? FileManager.default.removeItem(at: tmpURL)
            let resp = try? JSONDecoder().decode(UploadResponse.self, from: data)
            let msg = status == 401 ? "Неверный токен" : "Сервер ответил \(status) \(resp?.error ?? "")"
            store.markFailed(meta.key, msg)
            log.add("\(meta.name): \(msg)", .error)
            lastError = msg
            if status == 401 { pause() }
        }

        if !running && inflightKeys.isEmpty && state == .syncing { finish() }
        pump()
    }

    // MARK: После выгрузки

    private func flushAlbum() {
        guard settings.addToAlbum, !pendingAlbumIDs.isEmpty else { return }
        let ids = pendingAlbumIDs
        pendingAlbumIDs.removeAll()
        let name = settings.albumNameAfter.isEmpty ? "На SSD" : settings.albumNameAfter
        PHPhotoLibrary.shared().performChanges({
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
            let opts = PHFetchOptions()
            opts.predicate = NSPredicate(format: "title = %@", name)
            let existing = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: opts).firstObject
            let req: PHAssetCollectionChangeRequest?
            if let existing { req = PHAssetCollectionChangeRequest(for: existing) }
            else { req = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name) }
            req?.addAssets(assets)
        }, completionHandler: nil)
    }

    /// Снимки, у которых все нужные части уже на SSD — их можно удалить с iPhone.
    func fullyUploadedAssetIDs() async -> [String] {
        let cfg = scanConfig()
        let refs = await Self.scan(cfg)
        let done = Set(store.done.keys)
        var byAsset: [String: Bool] = [:]
        for r in refs { byAsset[r.assetID, default: true] = (byAsset[r.assetID] ?? true) && done.contains(r.key) }
        return byAsset.filter { $0.value }.map(\.key)
    }

    func deleteFromPhone(_ ids: [String]) async -> Bool {
        await withCheckedContinuation { c in
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.deleteAssets(PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil))
            }) { ok, _ in c.resume(returning: ok) }
        }
    }

    func clearTemp() {
        let fm = FileManager.default
        guard inflightKeys.isEmpty, let files = try? fm.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: nil) else { return }
        files.forEach { try? fm.removeItem(at: $0) }
    }

    // MARK: Фон

    func scheduleBackground() {
        guard settings.backgroundEnabled || settings.smartNight else {
            BGTaskScheduler.shared.cancelAllTaskRequests()
            return
        }
        if settings.backgroundEnabled {
            let refresh = BGAppRefreshTaskRequest(identifier: Self.refreshTaskID)
            refresh.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
            try? BGTaskScheduler.shared.submit(refresh)
        }

        // Долгая задача: днём — по настройке, ночью («умная ночь») — на зарядке после полуночи.
        let proc = BGProcessingTaskRequest(identifier: Self.processingTaskID)
        proc.requiresNetworkConnectivity = true
        if settings.smartNight {
            proc.requiresExternalPower = true
            proc.earliestBeginDate = Self.nextNight()
        } else {
            proc.requiresExternalPower = settings.backgroundOnlyCharging
            proc.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        }
        try? BGTaskScheduler.shared.submit(proc)
    }

    static func nextNight() -> Date {
        let cal = Calendar.current
        let now = Date()
        var c = cal.dateComponents([.year, .month, .day], from: now)
        c.hour = 0; c.minute = 30
        let tonight = cal.date(from: c) ?? now
        if now < tonight { return tonight }
        let hour = cal.component(.hour, from: now)
        if hour < 6 { return now } // уже ночь — можно сразу
        return cal.date(byAdding: .day, value: 1, to: tonight) ?? now
    }

    func handleBackgroundTask(_ task: BGTask) {
        let isProcessing = task.identifier == Self.processingTaskID
        scheduleBackground()
        task.expirationHandler = { [weak self] in
            Task { @MainActor in self?.running = false; self?.store.saveNow() }
        }
        guard settings.backgroundEnabled || settings.smartNight else { task.setTaskCompleted(success: true); return }
        isNightRun = isProcessing && settings.smartNight
        start(reason: isNightRun ? "умная ночь" : "фон")
        Task {
            // Короткая задача: только передать очередь системе. Долгая (ночь): ждём, пока всё уйдёт.
            let maxSeconds = isProcessing ? 25 * 60 : 25
            for _ in 0..<maxSeconds {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                let handedOver = self.queue.isEmpty && self.exporting == 0
                if handedOver && (!isProcessing || self.inflightKeys.isEmpty) { break }
                if !self.running && self.exporting == 0 { break }
            }
            self.store.saveNow()
            self.isNightRun = false
            task.setTaskCompleted(success: true)
        }
    }
}

// MARK: - URLSession

extension SyncEngine: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let key = Self.meta(of: dataTask)?.key else { return }
        Task { @MainActor in self.handleData(key: key, data: data) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                                totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        let key = Self.meta(of: task)?.key
        let id = task.taskIdentifier
        let isFg = session.configuration.identifier == nil
        Task { @MainActor in
            self.handleSent(bytesSent, key: key, taskID: id, isFg: isFg, sent: totalBytesSent, expected: totalBytesExpectedToSend)
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let meta = Self.meta(of: task)
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let id = task.taskIdentifier
        let isFg = session.configuration.identifier == nil
        let req = task.originalRequest
        let desc = task.taskDescription
        Task { @MainActor in
            self.handleComplete(meta: meta, taskID: id, isFg: isFg, status: status, error: error, request: req, desc: desc)
        }
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let id = session.configuration.identifier ?? ""
        Task { @MainActor in
            self.store.saveNow()
            // Если сейчас готовится следующая пачка — сигнал отдадим по её окончании.
            if !self.refillActive { self.backgroundCompletionHandlers.removeValue(forKey: id)?() }
        }
    }
}

// MARK: - Новые снимки

extension SyncEngine: PHPhotoLibraryChangeObserver {
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            guard self.settings.autoStart, self.settings.onboarded,
                  UIApplication.shared.applicationState == .active, !self.running else { return }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            self.start(reason: "новые снимки")
        }
    }
}
