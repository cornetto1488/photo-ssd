import Foundation
import SwiftUI

// MARK: - Варианты настроек

enum LayoutPreset: String, CaseIterable, Identifiable, Codable {
    case flat, byType, byYear, byYearMonth, byYearMonthDay, byTypeYearMonth, byYearMonthType, byAlbum, byAlbumYear, custom
    var id: String { rawValue }
    var title: String {
        switch self {
        case .flat: return "Без папок"
        case .byType: return "По типу"
        case .byYear: return "По году"
        case .byYearMonth: return "Год / месяц"
        case .byYearMonthDay: return "Год / месяц / день"
        case .byTypeYearMonth: return "Тип / год / месяц"
        case .byYearMonthType: return "Год / месяц / тип"
        case .byAlbum: return "По альбому"
        case .byAlbumYear: return "Альбом / год"
        case .custom: return "Свой шаблон"
        }
    }
    var template: String {
        switch self {
        case .flat: return ""
        case .byType: return "{тип}"
        case .byYear: return "{год}"
        case .byYearMonth: return "{год}/{мес}"
        case .byYearMonthDay: return "{год}/{мес}/{день}"
        case .byTypeYearMonth: return "{тип}/{год}/{мес}"
        case .byYearMonthType: return "{год}/{мес}/{тип}"
        case .byAlbum: return "{альбом}"
        case .byAlbumYear: return "{альбом}/{год}"
        case .custom: return ""
        }
    }
}

enum MonthStyle: String, CaseIterable, Identifiable, Codable {
    case number, numberName, name
    var id: String { rawValue }
    var title: String {
        switch self {
        case .number: return "10"
        case .numberName: return "10 Октябрь"
        case .name: return "Октябрь"
        }
    }
}

enum FileNaming: String, CaseIterable, Identifiable, Codable {
    case original, dateTime, dateTimeOriginal
    var id: String { rawValue }
    var title: String {
        switch self {
        case .original: return "Как на iPhone"
        case .dateTime: return "Дата и время"
        case .dateTimeOriginal: return "Дата + имя"
        }
    }
    var example: String {
        switch self {
        case .original: return "IMG_2020.HEIC"
        case .dateTime: return "2026-10-12_18-30-05.HEIC"
        case .dateTimeOriginal: return "2026-10-12_18-30-05_IMG_2020.HEIC"
        }
    }
}

enum VersionMode: String, CaseIterable, Identifiable, Codable {
    case original, edited, both
    var id: String { rawValue }
    var title: String {
        switch self {
        case .original: return "Оригинал"
        case .edited: return "С правками"
        case .both: return "Обе версии"
        }
    }
}

enum PhotoFormat: String, CaseIterable, Identifiable, Codable {
    case original, jpeg
    var id: String { rawValue }
    var title: String { self == .original ? "Как есть (HEIC)" : "Конвертировать в JPEG" }
}

enum LiveVideoNaming: String, CaseIterable, Identifiable, Codable {
    case sameName, doubleExt
    var id: String { rawValue }
    var title: String { self == .sameName ? "IMG_2020.MOV" : "IMG_2020.HEIC.MOV" }
}

enum BurstMode: String, CaseIterable, Identifiable, Codable {
    case best, all
    var id: String { rawValue }
    var title: String { self == .best ? "Только лучший кадр" : "Все кадры серии" }
}

// MARK: - Настройки

@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()
    private let d = UserDefaults.standard

    // Сервер
    @Published var serverURL: String { didSet { d.set(serverURL, forKey: "serverURL") } }
    @Published var token: String { didSet { Keychain.set(token, for: "token") } }

    // Источник
    @Published var albumID: String { didSet { d.set(albumID, forKey: "albumID") } }      // "" = вся медиатека
    @Published var albumTitle: String { didSet { d.set(albumTitle, forKey: "albumTitle") } }
    @Published var includePhotos: Bool { didSet { d.set(includePhotos, forKey: "includePhotos") } }
    @Published var includeLive: Bool { didSet { d.set(includeLive, forKey: "includeLive") } }
    @Published var includeVideos: Bool { didSet { d.set(includeVideos, forKey: "includeVideos") } }
    @Published var includeScreenshots: Bool { didSet { d.set(includeScreenshots, forKey: "includeScreenshots") } }
    @Published var includeHidden: Bool { didSet { d.set(includeHidden, forKey: "includeHidden") } }
    @Published var burstMode: BurstMode { didSet { d.set(burstMode.rawValue, forKey: "burstMode") } }
    @Published var versionMode: VersionMode { didSet { d.set(versionMode.rawValue, forKey: "versionMode") } }
    @Published var sinceEnabled: Bool { didSet { d.set(sinceEnabled, forKey: "sinceEnabled") } }
    @Published var sinceDate: Date { didSet { d.set(sinceDate, forKey: "sinceDate") } }

    // Формат
    @Published var photoFormat: PhotoFormat { didSet { d.set(photoFormat.rawValue, forKey: "photoFormat") } }
    @Published var jpegQuality: Double { didSet { d.set(jpegQuality, forKey: "jpegQuality") } }
    @Published var liveVideoNaming: LiveVideoNaming { didSet { d.set(liveVideoNaming.rawValue, forKey: "liveVideoNaming") } }

    // Раскладка
    @Published var baseFolder: String { didSet { d.set(baseFolder, forKey: "baseFolder") } }
    @Published var layoutPreset: LayoutPreset { didSet { d.set(layoutPreset.rawValue, forKey: "layoutPreset") } }
    @Published var customTemplate: String { didSet { d.set(customTemplate, forKey: "customTemplate") } }
    @Published var monthStyle: MonthStyle { didSet { d.set(monthStyle.rawValue, forKey: "monthStyle") } }
    @Published var fileNaming: FileNaming { didSet { d.set(fileNaming.rawValue, forKey: "fileNaming") } }
    @Published var typeNamePhoto: String { didSet { d.set(typeNamePhoto, forKey: "typeNamePhoto") } }
    @Published var typeNameVideo: String { didSet { d.set(typeNameVideo, forKey: "typeNameVideo") } }
    @Published var typeNameLive: String { didSet { d.set(typeNameLive, forKey: "typeNameLive") } }
    @Published var typeNameScreenshot: String { didSet { d.set(typeNameScreenshot, forKey: "typeNameScreenshot") } }
    @Published var noAlbumName: String { didSet { d.set(noAlbumName, forKey: "noAlbumName") } }

    // Передача
    @Published var wifiOnly: Bool { didSet { d.set(wifiOnly, forKey: "wifiOnly") } }
    @Published var backgroundEnabled: Bool { didSet { d.set(backgroundEnabled, forKey: "backgroundEnabled") } }
    @Published var backgroundOnlyCharging: Bool { didSet { d.set(backgroundOnlyCharging, forKey: "backgroundOnlyCharging") } }
    @Published var autoStart: Bool { didSet { d.set(autoStart, forKey: "autoStart") } }
    @Published var maxConcurrent: Int { didSet { d.set(maxConcurrent, forKey: "maxConcurrent") } }
    @Published var allowICloudDownload: Bool { didSet { d.set(allowICloudDownload, forKey: "allowICloudDownload") } }

    // После выгрузки
    @Published var addToAlbum: Bool { didSet { d.set(addToAlbum, forKey: "addToAlbum") } }
    @Published var albumNameAfter: String { didSet { d.set(albumNameAfter, forKey: "albumNameAfter") } }

    // Умная ночь и отклик
    @Published var smartNight: Bool { didSet { d.set(smartNight, forKey: "smartNight") } }
    @Published var morningHour: Int { didSet { d.set(morningHour, forKey: "morningHour") } }
    @Published var haptics: Bool { didSet { d.set(haptics, forKey: "haptics") } }
    @Published var liveActivity: Bool { didSet { d.set(liveActivity, forKey: "liveActivity") } }
    /// Системная плашка iOS 26 «продолжить в фоне» — вторая карточка на экране блокировки, по умолчанию выключена.
    @Published var systemContinue: Bool { didSet { d.set(systemContinue, forKey: "systemContinue") } }

    @Published var onboarded: Bool { didSet { d.set(onboarded, forKey: "onboarded") } }

    private init() {
        let d = UserDefaults.standard
        func s(_ k: String, _ def: String) -> String { d.string(forKey: k) ?? def }
        func b(_ k: String, _ def: Bool) -> Bool { d.object(forKey: k) as? Bool ?? def }
        func e<T: RawRepresentable>(_ k: String, _ def: T) -> T where T.RawValue == String {
            T(rawValue: d.string(forKey: k) ?? "") ?? def
        }

        serverURL = s("serverURL", "http://192.168.1.1:8099")
        token = Keychain.get("token") ?? ""

        albumID = s("albumID", "")
        albumTitle = s("albumTitle", "Вся медиатека")
        includePhotos = b("includePhotos", true)
        includeLive = b("includeLive", true)
        includeVideos = b("includeVideos", true)
        includeScreenshots = b("includeScreenshots", true)
        includeHidden = b("includeHidden", false)
        burstMode = e("burstMode", BurstMode.best)
        versionMode = e("versionMode", VersionMode.original)
        sinceEnabled = b("sinceEnabled", false)
        sinceDate = d.object(forKey: "sinceDate") as? Date ?? Calendar.current.date(byAdding: .month, value: -6, to: Date())!

        photoFormat = e("photoFormat", PhotoFormat.original)
        jpegQuality = d.object(forKey: "jpegQuality") as? Double ?? 0.9
        liveVideoNaming = e("liveVideoNaming", LiveVideoNaming.sameName)

        baseFolder = s("baseFolder", "iPhone")
        layoutPreset = e("layoutPreset", LayoutPreset.byYearMonth)
        customTemplate = s("customTemplate", "{год}/{мес} {месяц}")
        monthStyle = e("monthStyle", MonthStyle.number)
        fileNaming = e("fileNaming", FileNaming.original)
        typeNamePhoto = s("typeNamePhoto", "Фото")
        typeNameVideo = s("typeNameVideo", "Видео")
        typeNameLive = s("typeNameLive", "Live")
        typeNameScreenshot = s("typeNameScreenshot", "Скриншоты")
        noAlbumName = s("noAlbumName", "Без альбома")

        wifiOnly = b("wifiOnly", false)
        backgroundEnabled = b("backgroundEnabled", true)
        backgroundOnlyCharging = b("backgroundOnlyCharging", false)
        autoStart = b("autoStart", true)
        maxConcurrent = d.object(forKey: "maxConcurrent") as? Int ?? 2
        allowICloudDownload = b("allowICloudDownload", true)

        addToAlbum = b("addToAlbum", false)
        albumNameAfter = s("albumNameAfter", "На SSD")

        smartNight = b("smartNight", false)
        morningHour = d.object(forKey: "morningHour") as? Int ?? 8
        haptics = b("haptics", true)
        liveActivity = b("liveActivity", true)
        systemContinue = b("systemContinue", false)

        onboarded = b("onboarded", false)

        // Режим автотеста (запуск из ZaletUITests): адрес и токен — из окружения.
        if ProcessInfo.processInfo.arguments.contains("-zaletUITest") {
            let env = ProcessInfo.processInfo.environment
            serverURL = env["ZALET_SERVER"] ?? serverURL
            token = env["ZALET_TOKEN"] ?? token
            onboarded = true
            autoStart = true
            wifiOnly = false
            backgroundEnabled = false
            smartNight = false
            liveActivity = false
            haptics = false
        }
    }

    var effectiveTemplate: String {
        layoutPreset == .custom ? customTemplate : layoutPreset.template
    }

    /// Ключ, от которого зависит путь файла. Если он поменялся — уже выгруженное не трогаем,
    /// а новые файлы раскладываются по-новому.
    var layoutSignature: String {
        [baseFolder, effectiveTemplate, monthStyle.rawValue, fileNaming.rawValue,
         typeNamePhoto, typeNameVideo, typeNameLive, typeNameScreenshot, noAlbumName,
         photoFormat.rawValue, liveVideoNaming.rawValue].joined(separator: "|")
    }

    var baseURL: URL? {
        var str = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !str.hasPrefix("http") { str = "http://" + str }
        while str.hasSuffix("/") { str.removeLast() }
        return URL(string: str)
    }
}

// MARK: - Keychain (токен храним не в UserDefaults)

enum Keychain {
    static func set(_ value: String, for key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrAccount as String: key,
                                   kSecAttrService as String: "ru.apodmarchuk.photossd"]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrAccount as String: key,
                                kSecAttrService as String: "ru.apodmarchuk.photossd",
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
