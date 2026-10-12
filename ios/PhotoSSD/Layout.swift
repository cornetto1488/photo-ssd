import Foundation

enum MediaKind: String, Codable {
    case photo, live, video, screenshot
}

/// Какая часть ассета выгружается.
enum ResourceRole: String, Codable, CaseIterable {
    case photo          // оригинал фото
    case photoEdited    // фото с правками
    case liveVideo      // видеочасть Live Photo
    case liveVideoEdited
    case video
    case videoEdited
}

struct MediaInfo {
    var date: Date
    var kind: MediaKind
    var album: String?
    var originalFilename: String   // имя ресурса на iPhone, например IMG_2020.HEIC
    var role: ResourceRole
    var photoFilename: String? = nil // для видео Live Photo — имя парного фото
}

/// Токены шаблона, доступные в настройках.
struct LayoutToken: Identifiable {
    let token: String
    let title: String
    var id: String { token }

    static let all: [LayoutToken] = [
        .init(token: "{год}", title: "Год"),
        .init(token: "{мес}", title: "Месяц"),
        .init(token: "{месяц}", title: "Название месяца"),
        .init(token: "{день}", title: "День"),
        .init(token: "{квартал}", title: "Квартал"),
        .init(token: "{тип}", title: "Тип"),
        .init(token: "{альбом}", title: "Альбом"),
        .init(token: "/", title: "Папка /")
    ]
}

enum Layout {
    static let monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
                             "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]

    @MainActor
    static func relativePath(for m: MediaInfo, settings s: AppSettings = .shared) -> String {
        relativePath(for: m, base: s.baseFolder, template: s.effectiveTemplate, monthStyle: s.monthStyle,
                     naming: s.fileNaming, typeNames: typeNames(s), noAlbum: s.noAlbumName,
                     jpeg: s.photoFormat == .jpeg, liveNaming: s.liveVideoNaming)
    }

    @MainActor
    static func typeNames(_ s: AppSettings) -> [MediaKind: String] {
        [.photo: s.typeNamePhoto, .video: s.typeNameVideo, .live: s.typeNameLive, .screenshot: s.typeNameScreenshot]
    }

    static func relativePath(for m: MediaInfo, base: String, template: String, monthStyle: MonthStyle,
                             naming: FileNaming, typeNames: [MediaKind: String], noAlbum: String,
                             jpeg: Bool, liveNaming: LiveVideoNaming) -> String {
        let cal = Calendar(identifier: .gregorian)
        let c = cal.dateComponents(in: .current, from: m.date)
        let year = String(format: "%04d", c.year ?? 1970)
        let month = c.month ?? 1
        let mm = String(format: "%02d", month)
        let monthName = monthNames[max(0, min(11, month - 1))]
        let dd = String(format: "%02d", c.day ?? 1)
        let quarter = "Q\((month - 1) / 3 + 1)"

        let monthToken: String
        switch monthStyle {
        case .number: monthToken = mm
        case .numberName: monthToken = "\(mm) \(monthName)"
        case .name: monthToken = monthName
        }

        var folder = template
        folder = folder.replacingOccurrences(of: "{год}", with: year)
        folder = folder.replacingOccurrences(of: "{месяц}", with: monthName)
        folder = folder.replacingOccurrences(of: "{мес}", with: monthToken)
        folder = folder.replacingOccurrences(of: "{день}", with: dd)
        folder = folder.replacingOccurrences(of: "{квартал}", with: quarter)
        folder = folder.replacingOccurrences(of: "{тип}", with: typeNames[m.kind] ?? "Фото")
        folder = folder.replacingOccurrences(of: "{альбом}", with: sanitize(m.album ?? noAlbum))

        let parts = ([base] + folder.split(separator: "/").map(String.init))
            .map { sanitize($0.trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.isEmpty }

        return (parts + [fileName(for: m, naming: naming, jpeg: jpeg, liveNaming: liveNaming)])
            .joined(separator: "/")
    }

    static func fileName(for m: MediaInfo, naming: FileNaming, jpeg: Bool, liveNaming: LiveVideoNaming) -> String {
        var original = m.originalFilename
        var ext = (original as NSString).pathExtension
        var stem = (original as NSString).deletingPathExtension

        let isPhotoRole = m.role == .photo || m.role == .photoEdited
        if isPhotoRole && jpeg && ["heic", "heif"].contains(ext.lowercased()) {
            ext = "JPG"
        }
        // Видео Live Photo называем по парному фото, чтобы они лежали рядом.
        if (m.role == .liveVideo || m.role == .liveVideoEdited), let photo = m.photoFilename {
            let photoStem = (photo as NSString).deletingPathExtension
            let photoExt = (photo as NSString).pathExtension
            stem = liveNaming == .doubleExt ? "\(photoStem).\(photoExt)" : photoStem
            ext = "MOV"
        }
        if m.role == .photoEdited || m.role == .videoEdited || m.role == .liveVideoEdited {
            stem += "_правка"
        }
        original = ext.isEmpty ? stem : "\(stem).\(ext)"

        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let stamp = f.string(from: m.date)

        switch naming {
        case .original: return sanitize(original)
        case .dateTime: return sanitize(ext.isEmpty ? stamp : "\(stamp).\(ext)")
        case .dateTimeOriginal: return sanitize("\(stamp)_\(original)")
        }
    }

    static func sanitize(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        var out = s.components(separatedBy: bad).joined(separator: "_")
        while out.hasPrefix(".") { out.removeFirst() }
        return out
    }

    /// Пример для экрана настроек.
    @MainActor
    static func example(kind: MediaKind = .photo) -> String {
        let s = AppSettings.shared
        var comps = DateComponents()
        comps.year = 2026; comps.month = 10; comps.day = 12; comps.hour = 18; comps.minute = 30; comps.second = 5
        let date = Calendar(identifier: .gregorian).date(from: comps) ?? Date()
        let name = kind == .video ? "IMG_2021.MOV" : "IMG_2020.HEIC"
        let m = MediaInfo(date: date, kind: kind, album: "Отпуск", originalFilename: name,
                          role: kind == .video ? .video : .photo)
        return "/" + relativePath(for: m, settings: s)
    }
}
