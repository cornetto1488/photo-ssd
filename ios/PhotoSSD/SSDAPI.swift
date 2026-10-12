import Foundation
import UIKit
import Photos
import AVFoundation
import ImageIO

// MARK: - Модели сервера v2

struct SSDItem: Decodable, Identifiable, Hashable {
    let id: String
    let path: String
    let size: Int64
    let time: Int64
    let date: Int64?
    let kind: String?
    let album: String?
    let thumb: Bool?
    let trashed: Int64?

    var name: String { (path as NSString).lastPathComponent }
    var takenDate: Date { Date(timeIntervalSince1970: TimeInterval((date ?? 0) > 0 ? date! : time)) }
    var isVideo: Bool { kind == "video" || kind == "livevideo" || ["mov", "mp4", "m4v"].contains((path as NSString).pathExtension.lowercased()) }
    var assetID: String? { id.hasPrefix("path:") ? nil : SyncStore.assetID(fromKey: id) }
    var role: ResourceRole? { id.split(separator: "#").last.flatMap { ResourceRole(rawValue: String($0)) } }
}

struct SSDEntry: Decodable, Identifiable, Hashable {
    let name: String
    let path: String
    let dir: Bool?
    let count: Int?
    let size: Int64?
    let mtime: Int64?
    let recordID: String?
    let date: Int64?
    let kind: String?
    let album: String?
    let thumb: Bool?
    var id: String { path }
    var isDir: Bool { dir ?? false }

    enum CodingKeys: String, CodingKey {
        case name, path, dir, count, size, mtime, date, kind, album, thumb
        case recordID = "id"
    }
    var isVideo: Bool { kind == "video" || kind == "livevideo" || ["mov", "mp4", "m4v"].contains((name as NSString).pathExtension.lowercased()) }
    var isImage: Bool { ["heic", "heif", "jpg", "jpeg", "png", "dng", "gif", "webp", "tif", "tiff"].contains((name as NSString).pathExtension.lowercased()) }

    var asItem: SSDItem {
        SSDItem(id: recordID ?? "path:\(path)", path: path, size: size ?? 0, time: mtime ?? 0,
                date: date ?? mtime, kind: kind, album: album, thumb: thumb, trashed: nil)
    }
}

struct SSDAlbum: Decodable, Identifiable, Hashable { let name: String; let count: Int; var id: String { name } }

struct StatBucket: Decodable, Identifiable { let key: String; let count: Int; let bytes: Int64; var id: String { key } }

struct SSDStats: Decodable {
    let total: Int
    let bytes: Int64
    let oldest: Int64
    let newest: Int64
    let biggest: Int64
    let biggestPath: String
    let byMonth: [StatBucket]
    let byKind: [StatBucket]
    let uploadsByDay: [StatBucket]
}

struct ItemsPage: Decodable { let total: Int; let offset: Int; let items: [SSDItem] }

struct SSDFilter: Equatable {
    var query = ""
    var from: Date?
    var to: Date?
    var kind: String?   // photo, live, video, screenshot
    var album: String?

    var isActive: Bool { !query.isEmpty || from != nil || to != nil || kind != nil || album != nil }
}

// MARK: - Запросы

@MainActor
extension ServerAPI {
    static func get<T: Decodable>(_ path: String, _ query: [URLQueryItem] = [], as: T.Type, timeout: TimeInterval = 20) async throws -> T {
        var r = try request(path, query: query)
        r.timeoutInterval = timeout
        let (data, resp) = try await session.data(for: r)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func post(_ path: String, _ query: [URLQueryItem] = []) async throws {
        let (data, resp) = try await session.data(for: try request(path, query: query, method: "POST"))
        try check(resp, data)
    }

    static func items(_ f: SSDFilter, offset: Int, limit: Int = 300) async throws -> ItemsPage {
        var q: [URLQueryItem] = [.init(name: "offset", value: "\(offset)"), .init(name: "limit", value: "\(limit)")]
        if !f.query.isEmpty { q.append(.init(name: "q", value: f.query)) }
        if let from = f.from { q.append(.init(name: "from", value: "\(Int64(from.timeIntervalSince1970))")) }
        if let to = f.to { q.append(.init(name: "to", value: "\(Int64(to.timeIntervalSince1970))")) }
        if let k = f.kind { q.append(.init(name: "kind", value: k)) }
        if let a = f.album { q.append(.init(name: "album", value: a)) }
        return try await get("api/v1/items", q, as: ItemsPage.self)
    }

    static func browse(_ dir: String) async throws -> [SSDEntry] {
        struct W: Decodable { let entries: [SSDEntry] }
        return try await get("api/v1/browse", [.init(name: "dir", value: dir)], as: W.self).entries
    }

    static func albums() async throws -> [SSDAlbum] {
        struct W: Decodable { let albums: [SSDAlbum] }
        return try await get("api/v1/albums", as: W.self).albums
    }

    static func stats() async throws -> SSDStats { try await get("api/v1/stats", as: SSDStats.self, timeout: 30) }

    static func trashList() async throws -> (items: [SSDItem], days: Int) {
        struct W: Decodable { let items: [SSDItem]; let days: Int }
        let w = try await get("api/v1/trash", as: W.self)
        return (w.items, w.days)
    }

    static func moveToTrash(_ item: SSDItem) async throws {
        try await post("api/v1/trash", item.id.hasPrefix("path:") ? [.init(name: "path", value: item.path)] : [.init(name: "id", value: item.id)])
    }
    static func restoreFromTrash(_ id: String) async throws { try await post("api/v1/trash/restore", [.init(name: "id", value: id)]) }
    static func deleteForever(_ id: String) async throws { try await post("api/v1/trash/delete", [.init(name: "id", value: id)]) }
    static func emptyTrash() async throws { try await post("api/v1/trash/empty") }

    static func itemQuery(_ item: SSDItem) -> [URLQueryItem] {
        item.id.hasPrefix("path:") ? [.init(name: "path", value: item.path)] : [.init(name: "id", value: item.id)]
    }

    static func fileRequest(_ item: SSDItem) throws -> URLRequest {
        var r = try request("api/v1/file", query: itemQuery(item))
        r.timeoutInterval = 600
        return r
    }

    static func thumbRequest(_ item: SSDItem) throws -> URLRequest { try request("api/v1/thumb", query: itemQuery(item)) }

    static func uploadThumb(_ data: Data, for item: SSDItem) async {
        guard var r = try? request("api/v1/thumb", query: itemQuery(item), method: "PUT") else { return }
        r.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        _ = try? await session.upload(for: r, from: data)
    }

    static func uploadThumb(_ data: Data, id: String) async {
        guard var r = try? request("api/v1/thumb", query: [.init(name: "id", value: id)], method: "PUT") else { return }
        r.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        _ = try? await session.upload(for: r, from: data)
    }

    /// Скачать оригинал во временный файл (с кэшем).
    static func download(_ item: SSDItem) async throws -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("ssd-files", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let key = thumbCacheKey(item)
        let dst = dir.appendingPathComponent(key + "." + (item.path as NSString).pathExtension)
        if let attrs = try? FileManager.default.attributesOfItem(atPath: dst.path),
           (attrs[.size] as? NSNumber)?.int64Value == item.size, item.size > 0 {
            return dst
        }
        let big = URLSession(configuration: .default)
        let (tmp, resp) = try await big.download(for: try fileRequest(item))
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(http.statusCode, "не удалось скачать")
        }
        try? FileManager.default.removeItem(at: dst)
        try FileManager.default.moveItem(at: tmp, to: dst)
        return dst
    }

    nonisolated static func thumbCacheKey(_ item: SSDItem) -> String {
        let src = item.id.hasPrefix("path:") ? item.path : item.id
        return String(src.unicodeScalars.reduce(UInt64(1469598103934665603)) { ($0 ^ UInt64($1.value)) &* 1099511628211 }, radix: 36)
    }
}

// MARK: - Превью с кэшем

@MainActor
final class ThumbLoader {
    static let shared = ThumbLoader()
    private let memory = NSCache<NSString, UIImage>()
    private var inflight: [String: Task<UIImage?, Never>] = [:]
    private let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("ssd-thumbs", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    init() { memory.countLimit = 600 }

    func image(for item: SSDItem) async -> UIImage? {
        let key = ServerAPI.thumbCacheKey(item)
        if let img = memory.object(forKey: key as NSString) { return img }
        if let t = inflight[key] { return await t.value }
        let task = Task<UIImage?, Never> { await self.load(item, key: key) }
        inflight[key] = task
        let img = await task.value
        inflight[key] = nil
        if let img { memory.setObject(img, forKey: key as NSString) }
        return img
    }

    private func load(_ item: SSDItem, key: String) async -> UIImage? {
        let file = dir.appendingPathComponent(key + ".jpg")
        if let data = try? Data(contentsOf: file), let img = UIImage(data: data) { return img }

        // 1. Превью с сервера.
        if let req = try? ServerAPI.thumbRequest(item),
           let result = try? await ServerAPI.session.data(for: req),
           (result.1 as? HTTPURLResponse)?.statusCode == 200, let img = UIImage(data: result.0) {
            try? result.0.write(to: file)
            return img
        }

        // 2. Превью нет (HEIC/видео без превью) — делаем сами и отправляем на роутер.
        var made: UIImage?
        if item.isVideo {
            made = await VideoThumb.make(item)
        } else if item.size < 60_000_000, let url = try? await ServerAPI.download(item) {
            made = Self.downscale(url: url, max: 400)
        }
        guard let made, let jpg = made.jpegData(compressionQuality: 0.8) else { return nil }
        try? jpg.write(to: file)
        await ServerAPI.uploadThumb(jpg, for: item)
        return made
    }

    nonisolated static func downscale(url: URL, max: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: max]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// Превью снимка из медиатеки — отправляется на роутер сразу после выгрузки.
    nonisolated static func libraryThumb(_ asset: PHAsset) async -> Data? {
        await withCheckedContinuation { c in
            let o = PHImageRequestOptions()
            o.deliveryMode = .highQualityFormat
            o.isNetworkAccessAllowed = true
            o.isSynchronous = false
            o.resizeMode = .exact
            var resumed = false
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 400, height: 400),
                                                  contentMode: .aspectFill, options: o) { img, info in
                if resumed { return }
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                resumed = true
                c.resume(returning: img?.jpegData(compressionQuality: 0.8))
            }
        }
    }
}

enum VideoThumb {
    @MainActor
    static func asset(for item: SSDItem) -> AVURLAsset? {
        guard let req = try? ServerAPI.fileRequest(item), let url = req.url else { return nil }
        let headers = ["Authorization": req.value(forHTTPHeaderField: "Authorization") ?? ""]
        return AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])
    }

    @MainActor
    static func make(_ item: SSDItem) async -> UIImage? {
        guard let asset = asset(for: item) else { return nil }
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 400, height: 400)
        return await withCheckedContinuation { c in
            gen.generateCGImagesAsynchronously(forTimes: [NSValue(time: CMTime(seconds: 0.5, preferredTimescale: 600))]) { _, cg, _, _, _ in
                c.resume(returning: cg.map { UIImage(cgImage: $0) })
            }
        }
    }
}
