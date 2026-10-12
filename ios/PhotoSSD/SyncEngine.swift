import Foundation
import Photos
import UIKit
import ImageIO
import UniformTypeIdentifiers
import BackgroundTasks
import Network

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
    private var responseData: [Int: Data] = [:]
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
            Task { @MainActor in SyncEngine.shared.onWifiChange(wifi) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "zalet.path"))
    }

    private let pathMonitor = NWPathMonitor()
    private(set) var onWifi = true

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
        let pending = result.filter { !doneKeys.contains($0.key) && !inflightKeys.contains($0.key) }

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
        while running && (inflightKeys.count + exporting) < limit && !queue.isEmpty {
            let ref = queue.removeFirst()
            exporting += 1
            preparingCount = exporting
            Task { await self.prepareAndUpload(ref) }
        }
        if queue.isEmpty && inflightKeys.isEmpty && exporting == 0 && state == .syncing {
            finish()
        }
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
        defer { exporting -= 1; preparingCount = exporting; queuedKeys.remove(ref.key); pump() }
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
        var tmp = tmpDir.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : ".\(ext)"))
        do {
            try await Self.export(res, to: tmp, network: settings.allowICloudDownload)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
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

        // 3. Фоновая передача.
        do {
            let kindParam = (ref.role == .liveVideo || ref.role == .liveVideoEdited) ? "livevideo" : info.kind.rawValue
            let req = try ServerAPI.uploadRequest(path: relPath, id: ref.key, size: size, mtime: info.date,
                                                  kind: kindParam, album: info.album)
            let task = activeSession.uploadTask(with: req, fromFile: tmp)
            let meta = TaskMeta(key: ref.key, path: relPath, tmp: tmp.lastPathComponent, size: size, name: (relPath as NSString).lastPathComponent)
            task.taskDescription = String(data: (try? JSONEncoder().encode(meta)) ?? Data(), encoding: .utf8)
            inflightKeys.insert(ref.key)
            task.resume()
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            store.markFailed(ref.key, error.localizedDescription)
        }
    }

    nonisolated static func export(_ res: PHAssetResource, to url: URL, network: Bool) async throws {
        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = network
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: res, toFile: url, options: opts) { err in
                if let err { c.resume(throwing: err) } else { c.resume() }
            }
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

    fileprivate func handleData(taskID: Int, data: Data) {
        responseData[taskID, default: Data()].append(data)
    }

    fileprivate func handleSent(_ bytes: Int64) {
        let now = Date()
        bytesWindow.append((now, bytes))
        bytesWindow.removeAll { now.timeIntervalSince($0.0) > 5 }
        let sum = bytesWindow.reduce(Int64(0)) { $0 + $1.1 }
        speed = Double(sum) / 5
    }

    fileprivate func handleComplete(meta: TaskMeta?, taskID: Int, status: Int, error: Error?) {
        let data = responseData.removeValue(forKey: taskID) ?? Data()
        guard let meta else { return }
        inflightKeys.remove(meta.key)
        try? FileManager.default.removeItem(at: tmpDir.appendingPathComponent(meta.tmp))

        if let error {
            let ns = error as NSError
            if ns.code == NSURLErrorCancelled {
                log.add("Отменено: \(meta.name)", .warn)
            } else {
                store.markFailed(meta.key, error.localizedDescription)
                log.add("Ошибка \(meta.name): \(error.localizedDescription)", .error)
                lastError = error.localizedDescription
            }
        } else if (200..<300).contains(status) {
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
        let id = dataTask.taskIdentifier
        Task { @MainActor in self.handleData(taskID: id, data: data) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                                totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        Task { @MainActor in self.handleSent(bytesSent) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let meta = Self.meta(of: task)
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let id = task.taskIdentifier
        Task { @MainActor in self.handleComplete(meta: meta, taskID: id, status: status, error: error) }
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let id = session.configuration.identifier ?? ""
        Task { @MainActor in
            self.store.saveNow()
            self.backgroundCompletionHandlers.removeValue(forKey: id)?()
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
