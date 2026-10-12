import Foundation

struct ServerStatus: Decodable {
    let ok: Bool
    let version: String
    let free: Int64
    let total: Int64
    let files: Int
    let trash: Int?
    let trashBytes: Int64?
}

struct ServerRecord: Decodable {
    let id: String
    let path: String
    let size: Int64
}

struct UploadResponse: Decodable {
    let status: String?
    let path: String?
    let size: Int64?
    let error: String?
}

enum APIError: LocalizedError {
    case badURL, unauthorized, http(Int, String), noToken
    var errorDescription: String? {
        switch self {
        case .badURL: return "Неверный адрес сервера"
        case .noToken: return "Не указан токен доступа"
        case .unauthorized: return "Неверный токен доступа"
        case .http(let code, let msg): return "Сервер ответил \(code): \(msg)"
        }
    }
}

@MainActor
enum ServerAPI {
    static var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 8
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    static func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET") throws -> URLRequest {
        let s = AppSettings.shared
        guard let base = s.baseURL, var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        else { throw APIError.badURL }
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw APIError.badURL }
        guard !s.token.isEmpty else { throw APIError.noToken }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(s.token)", forHTTPHeaderField: "Authorization")
        return r
    }

    static func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONDecoder().decode(UploadResponse.self, from: data))?.error ?? ""
            throw APIError.http(http.statusCode, msg)
        }
    }

    static func ping() async throws -> ServerStatus {
        let (data, resp) = try await session.data(for: try request("api/v1/ping"))
        try check(resp, data)
        return try JSONDecoder().decode(ServerStatus.self, from: data)
    }

    static func index() async throws -> [ServerRecord] {
        var r = try request("api/v1/index")
        r.timeoutInterval = 60
        let (data, resp) = try await session.data(for: r)
        try check(resp, data)
        struct Wrap: Decodable { let items: [ServerRecord] }
        return try JSONDecoder().decode(Wrap.self, from: data).items
    }

    static func forget(id: String) async throws {
        let (data, resp) = try await session.data(for: try request("api/v1/forget", query: [.init(name: "id", value: id)], method: "POST"))
        try check(resp, data)
    }

    static func uploadRequest(path: String, id: String, size: Int64, mtime: Date, kind: String, album: String?) throws -> URLRequest {
        var q: [URLQueryItem] = [
            .init(name: "path", value: path),
            .init(name: "id", value: id),
            .init(name: "size", value: String(size)),
            .init(name: "mtime", value: String(Int64(mtime.timeIntervalSince1970))),
            .init(name: "date", value: String(Int64(mtime.timeIntervalSince1970))),
            .init(name: "kind", value: kind)
        ]
        if let album, !album.isEmpty { q.append(.init(name: "album", value: album)) }
        var r = try request("api/v1/upload", query: q, method: "PUT")
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 600
        return r
    }
}
