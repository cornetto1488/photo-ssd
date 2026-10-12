import SwiftUI
import Photos

// Общий стиль форм
struct ThemedForm<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        Form { content }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .font(F.sans(15))
    }
}

struct SectionHeader: View {
    let text: String
    var number: String? = nil
    var body: some View { MonoLabel(text: text, number: number).padding(.bottom, 2) }
}

extension View {
    func row() -> some View { listRowBackground(Theme.panel) }
}

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        NavigationStack {
            ThemedForm {
                Section {
                    NavigationLink { ServerSettings() } label: {
                        SettingsRow(icon: "server.rack", title: "Сервер",
                                    value: engine.serverOnline ? "в сети" : "нет связи",
                                    valueColor: engine.serverOnline ? Theme.live : Theme.danger)
                    }.row()
                } header: { SectionHeader(text: "Подключение", number: "01") }

                Section {
                    NavigationLink { SourceSettings() } label: {
                        SettingsRow(icon: "photo.on.rectangle.angled", title: "Что выгружать", value: settings.albumTitle)
                    }.row()
                    NavigationLink { LayoutSettings() } label: {
                        SettingsRow(icon: "folder.badge.gearshape", title: "Раскладка по папкам", value: settings.layoutPreset.title)
                    }.row()
                    NavigationLink { FormatSettings() } label: {
                        SettingsRow(icon: "doc.richtext", title: "Формат файлов", value: settings.photoFormat == .jpeg ? "JPEG" : "Оригинал")
                    }.row()
                } header: { SectionHeader(text: "Медиатека", number: "02") }

                Section {
                    NavigationLink { TransferSettings() } label: {
                        SettingsRow(icon: "arrow.up.arrow.down.circle", title: "Передача и фон", value: settings.wifiOnly ? "только Wi-Fi" : "любая сеть")
                    }.row()
                    NavigationLink { NightSettings() } label: {
                        SettingsRow(icon: "moon.stars.fill", title: "Умная ночь и отклик", value: settings.smartNight ? "вкл" : "выкл",
                                    valueColor: settings.smartNight ? Theme.acc : Theme.muted)
                    }.row()
                    NavigationLink { AfterSettings() } label: {
                        SettingsRow(icon: "checkmark.seal", title: "После выгрузки", value: settings.addToAlbum ? "в альбом" : "")
                    }.row()
                } header: { SectionHeader(text: "Синхронизация", number: "03") }

                Section {
                    NavigationLink { LogView() } label: {
                        SettingsRow(icon: "list.bullet.rectangle", title: "Журнал событий", value: "")
                    }.row()
                    NavigationLink { MaintenanceSettings() } label: {
                        SettingsRow(icon: "wrench.and.screwdriver", title: "Обслуживание", value: "")
                    }.row()
                    NavigationLink { AboutView() } label: {
                        SettingsRow(icon: "info.circle", title: "О приложении и авторе", value: "2.0")
                    }.row()
                } header: { SectionHeader(text: "Прочее", number: "04") }
            }
            .navigationTitle("Настройки")
        }
    }
}

struct SettingsRow: View {
    let icon: String
    let title: String
    var value: String = ""
    var valueColor: Color = Theme.muted
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundColor(Theme.acc).frame(width: 26)
            Text(title).font(F.sans(15, 500)).foregroundColor(Theme.ink)
            Spacer()
            Text(value).font(F.mono(12)).foregroundColor(valueColor).lineLimit(1)
        }
        .padding(.vertical, 4)
    }
}

struct Hint: View {
    let text: String
    var body: some View { Text(text).font(F.sans(12)).foregroundColor(Theme.muted) }
}

// MARK: - Сервер

struct ServerSettings: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var engine: SyncEngine
    @State private var checking = false
    @State private var showToken = false

    var body: some View {
        ThemedForm {
            Section {
                TextField("http://192.168.1.1:8099", text: $settings.serverURL)
                    .font(F.mono(14)).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).row()
            } header: { SectionHeader(text: "Адрес") } footer: {
                Hint(text: "Дома и через Tailscale работает один и тот же адрес роутера: http://192.168.1.1:8099")
            }

            Section {
                HStack {
                    Group {
                        if showToken { TextField("токен", text: $settings.token) }
                        else { SecureField("токен", text: $settings.token) }
                    }
                    .font(F.mono(14)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button { showToken.toggle() } label: { Image(systemName: showToken ? "eye.slash" : "eye") }
                        .foregroundColor(Theme.muted)
                }.row()
            } header: { SectionHeader(text: "Токен доступа") } footer: {
                Hint(text: "Токен хранится в связке ключей iPhone.")
            }

            Section {
                Button {
                    Task { checking = true; await engine.refreshServer(); checking = false }
                } label: {
                    HStack {
                        Text("Проверить подключение").foregroundColor(Theme.acc)
                        Spacer()
                        if checking { ProgressView() }
                    }
                }.row()
                if let st = engine.serverStatus, engine.serverOnline {
                    LabeledContent("Состояние") { Text("в сети").foregroundColor(Theme.live) }.row()
                    LabeledContent("Свободно") { Text(formatBytes(st.free)).font(F.mono(13)) }.row()
                    LabeledContent("Всего") { Text(formatBytes(st.total)).font(F.mono(13)) }.row()
                    LabeledContent("Файлов в журнале роутера") { Text("\(st.files)").font(F.mono(13)) }.row()
                    LabeledContent("Версия сервера") { Text(st.version).font(F.mono(13)) }.row()
                } else if let e = engine.lastError {
                    Text(e).foregroundColor(Theme.danger).font(F.sans(13)).row()
                }
            } header: { SectionHeader(text: "Проверка") }
        }
        .navigationTitle("Сервер")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Что выгружать

struct AlbumOption: Identifiable, Hashable {
    let id: String
    let title: String
    let count: Int
}

struct SourceSettings: View {
    @EnvironmentObject var settings: AppSettings
    @State private var albums: [AlbumOption] = []

    var body: some View {
        ThemedForm {
            Section {
                Picker("Альбом", selection: Binding(
                    get: { settings.albumID },
                    set: { id in
                        settings.albumID = id
                        settings.albumTitle = albums.first(where: { $0.id == id })?.title ?? "Вся медиатека"
                    })) {
                    Text("Вся медиатека").tag("")
                    ForEach(albums) { a in Text("\(a.title) · \(a.count)").tag(a.id) }
                }.row()
            } header: { SectionHeader(text: "Откуда") } footer: {
                Hint(text: "«Вся медиатека» — все фото и видео, включая новые.")
            }

            Section {
                Toggle("Фото", isOn: $settings.includePhotos).row()
                Toggle("Видео", isOn: $settings.includeVideos).row()
                Toggle("Скриншоты", isOn: $settings.includeScreenshots).row()
                Toggle("Видеочасть Live Photo", isOn: $settings.includeLive).row()
                Toggle("Скрытые снимки", isOn: $settings.includeHidden).row()
            } header: { SectionHeader(text: "Типы") } footer: {
                Hint(text: "Если выключить «Видеочасть Live Photo», Live Photo выгрузятся как обычные фото.")
            }

            Section {
                Picker("Серии (burst)", selection: $settings.burstMode) {
                    ForEach(BurstMode.allCases) { Text($0.title).tag($0) }
                }.row()
                Picker("Отредактированные", selection: $settings.versionMode) {
                    ForEach(VersionMode.allCases) { Text($0.title).tag($0) }
                }.row()
            } header: { SectionHeader(text: "Версии") } footer: {
                Hint(text: "«Обе версии» — оригинал и копия с правками (к имени добавится «_правка»).")
            }

            Section {
                Toggle("Только начиная с даты", isOn: $settings.sinceEnabled).row()
                if settings.sinceEnabled {
                    DatePicker("Дата", selection: $settings.sinceDate, displayedComponents: .date)
                        .environment(\.locale, Locale(identifier: "ru_RU")).row()
                }
            } header: { SectionHeader(text: "Период") }
        }
        .navigationTitle("Что выгружать")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: loadAlbums)
    }

    private func loadAlbums() {
        var out: [AlbumOption] = []
        let fav = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumFavorites, options: nil)
        fav.enumerateObjects { c, _, _ in
            out.append(AlbumOption(id: c.localIdentifier, title: c.localizedTitle ?? "Избранное",
                                   count: PHAsset.fetchAssets(in: c, options: nil).count))
        }
        let user = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        user.enumerateObjects { c, _, _ in
            out.append(AlbumOption(id: c.localIdentifier, title: c.localizedTitle ?? "Альбом",
                                   count: PHAsset.fetchAssets(in: c, options: nil).count))
        }
        albums = out
    }
}

// MARK: - Раскладка

struct LayoutSettings: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        ThemedForm {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    MonoLabel(text: "Пример", color: Theme.acc)
                    ExampleLine(icon: "photo", path: Layout.example(kind: .photo))
                    ExampleLine(icon: "video", path: Layout.example(kind: .video))
                    if settings.includeLive {
                        ExampleLine(icon: "livephoto", path: liveExample)
                    }
                }
                .padding(.vertical, 6).row()
            } footer: {
                Hint(text: "Пример для снимка 12 октября 2026 года из альбома «Отпуск». Уже выгруженные файлы не переносятся — новая раскладка применяется к новым.")
            }

            Section {
                TextField("iPhone", text: $settings.baseFolder).font(F.mono(14)).autocorrectionDisabled().row()
            } header: { SectionHeader(text: "Корневая папка на SSD") } footer: {
                Hint(text: "Внутри SSD/Photos. Оставьте пустым, чтобы складывать прямо в Photos.")
            }

            Section {
                ForEach(LayoutPreset.allCases) { p in
                    Button { settings.layoutPreset = p } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.title).font(F.sans(15, 500)).foregroundColor(Theme.ink)
                                if p != .custom {
                                    Text(p.template.isEmpty ? "всё в одну папку" : p.template)
                                        .font(F.mono(11)).foregroundColor(Theme.muted)
                                }
                            }
                            Spacer()
                            if settings.layoutPreset == p {
                                Image(systemName: "checkmark").foregroundColor(Theme.acc).font(.system(size: 14, weight: .bold))
                            }
                        }
                    }.row()
                }
            } header: { SectionHeader(text: "Структура папок") }

            if settings.layoutPreset == .custom {
                Section {
                    TextField("{год}/{мес}", text: $settings.customTemplate)
                        .font(F.mono(15)).textInputAutocapitalization(.never).autocorrectionDisabled().row()
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(LayoutToken.all) { t in
                                Button { settings.customTemplate += t.token } label: {
                                    VStack(spacing: 2) {
                                        Text(t.token).font(F.mono(12, 600)).foregroundColor(Theme.acc)
                                        Text(t.title).font(F.sans(10)).foregroundColor(Theme.muted)
                                    }
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(Theme.panel2)
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line2, lineWidth: 1))
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                }.buttonStyle(.plain)
                            }
                            Button { settings.customTemplate = "" } label: {
                                Image(systemName: "delete.left").foregroundColor(Theme.muted).padding(8)
                            }.buttonStyle(.plain)
                        }.padding(.vertical, 4)
                    }.row()
                } header: { SectionHeader(text: "Свой шаблон") } footer: {
                    Hint(text: "Нажимайте на метки, чтобы добавить их. «/» — новая вложенная папка. Можно писать и свой текст: например «{год}/{мес} {месяц}» → 2026/10 Октябрь.")
                }
            }

            Section {
                Picker("Месяц", selection: $settings.monthStyle) {
                    ForEach(MonthStyle.allCases) { Text($0.title).tag($0) }
                }.row()
                Picker("Имена файлов", selection: $settings.fileNaming) {
                    ForEach(FileNaming.allCases) { Text($0.title).tag($0) }
                }.row()
                Text(settings.fileNaming.example).font(F.mono(12)).foregroundColor(Theme.muted).row()
            } header: { SectionHeader(text: "Формат имён") } footer: {
                Hint(text: "Метка {мес} выводится в выбранном формате месяца.")
            }

            Section {
                NamedField(title: "Фото", text: $settings.typeNamePhoto)
                NamedField(title: "Видео", text: $settings.typeNameVideo)
                NamedField(title: "Live Photo", text: $settings.typeNameLive)
                NamedField(title: "Скриншоты", text: $settings.typeNameScreenshot)
                NamedField(title: "Без альбома", text: $settings.noAlbumName)
            } header: { SectionHeader(text: "Названия папок") } footer: {
                Hint(text: "Как будут называться папки для меток {тип} и {альбом}.")
            }

            Section {
                Picker("Видео Live Photo", selection: $settings.liveVideoNaming) {
                    ForEach(LiveVideoNaming.allCases) { Text($0.title).tag($0) }
                }.row()
            } header: { SectionHeader(text: "Live Photo") } footer: {
                Hint(text: "Видеочасть Live Photo кладётся рядом с фото под тем же именем.")
            }
        }
        .navigationTitle("Раскладка")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var liveExample: String {
        let photo = Layout.example(kind: .live)
        let dir = (photo as NSString).deletingLastPathComponent
        let stem = settings.fileNaming == .original ? "IMG_2020" : ((photo as NSString).lastPathComponent as NSString).deletingPathExtension
        let name = settings.liveVideoNaming == .doubleExt ? "\(stem).HEIC.MOV" : "\(stem).MOV"
        return dir + "/" + name
    }
}

struct ExampleLine: View {
    let icon: String
    let path: String
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundColor(Theme.muted).frame(width: 18)
            Text(path).font(F.mono(12)).foregroundColor(Theme.ink).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct NamedField: View {
    let title: String
    @Binding var text: String
    var body: some View {
        HStack {
            Text(title).foregroundColor(Theme.ink)
            Spacer()
            TextField(title, text: $text).multilineTextAlignment(.trailing).font(F.mono(13)).foregroundColor(Theme.acc2)
        }.row()
    }
}

// MARK: - Формат

struct FormatSettings: View {
    @EnvironmentObject var settings: AppSettings
    var body: some View {
        ThemedForm {
            Section {
                Picker("Фото", selection: $settings.photoFormat) {
                    ForEach(PhotoFormat.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.inline).labelsHidden().row()
            } header: { SectionHeader(text: "Формат фото") } footer: {
                Hint(text: "HEIC — оригинал без потерь и вдвое меньше. JPEG удобнее для старых компьютеров и телевизоров. Видео всегда выгружаются как есть.")
            }
            if settings.photoFormat == .jpeg {
                Section {
                    VStack(alignment: .leading) {
                        HStack {
                            Text("Качество")
                            Spacer()
                            Text("\(Int(settings.jpegQuality * 100))%").font(F.mono(13)).foregroundColor(Theme.acc)
                        }
                        Slider(value: $settings.jpegQuality, in: 0.5...1.0, step: 0.05)
                    }.row()
                } header: { SectionHeader(text: "JPEG") }
            }
        }
        .navigationTitle("Формат файлов")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Передача

struct TransferSettings: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var engine: SyncEngine
    var body: some View {
        ThemedForm {
            Section {
                Toggle("Только по Wi-Fi", isOn: $settings.wifiOnly).row()
                Toggle("Загружать из iCloud", isOn: $settings.allowICloudDownload).row()
                Stepper(value: $settings.maxConcurrent, in: 1...4) {
                    HStack {
                        Text("Одновременно")
                        Spacer()
                        Text("\(settings.maxConcurrent)").font(F.mono(13)).foregroundColor(Theme.acc)
                    }
                }.row()
            } header: { SectionHeader(text: "Сеть") } footer: {
                Hint(text: "«Загружать из iCloud» — если оригинал хранится в iCloud, он будет скачан перед отправкой. Больше одновременных передач — быстрее, но больше временного места на iPhone.")
            }

            Section {
                Toggle("Запускать при открытии", isOn: $settings.autoStart).row()
                Toggle("Выгрузка в фоне", isOn: $settings.backgroundEnabled).row()
                if settings.backgroundEnabled {
                    Toggle("В фоне только на зарядке", isOn: $settings.backgroundOnlyCharging).row()
                }
            } header: { SectionHeader(text: "Автоматически") } footer: {
                Hint(text: "Начатые передачи продолжаются, даже если свернуть приложение. Новые снимки iOS даёт выгружать в фоне, когда сочтёт нужным — обычно ночью на зарядке и Wi-Fi.")
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Снял — и фото само улетело на SSD, не открывая ZALET:").font(F.sans(14, 600)).foregroundColor(Theme.ink)
                    Group {
                        Text("1. Откройте «Команды» → «Автоматизация» → «+».")
                        Text("2. Выберите «Приложение» → «Камера» → «Закрыто».")
                        Text("3. Отметьте «Выполнять сразу».")
                        Text("4. Действие: «ZALET» → «Выгрузить новые фото».")
                    }
                    .font(F.sans(13)).foregroundColor(Theme.muted)
                    Text("Так же можно повесить на «Зарядное устройство подключено» или на подключение к домашнему Wi-Fi.")
                        .font(F.sans(12)).foregroundColor(Theme.dim)
                }
                .padding(.vertical, 6).row()
            } header: { SectionHeader(text: "Сразу после съёмки") } footer: {
                Hint(text: "Команда работает в фоне около 30 секунд: за это время ZALET готовит новые снимки и отдаёт их iOS, а iOS досылает их сама. Ещё можно сказать Siri: «Залёт в ZALET».")
            }
        }
        .navigationTitle("Передача и фон")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: settings.wifiOnly) { _ in engine.refreshWifiWait() }
    }
}

// MARK: - Умная ночь

struct NightSettings: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var engine: SyncEngine
    @State private var denied = false

    var body: some View {
        ThemedForm {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "moon.stars.fill").font(.system(size: 28)).foregroundStyle(Theme.accGradient)
                    Text("Ставите iPhone на зарядку — ночью ZALET сам выгрузит всё новое, а утром пришлёт итог: «Залетело 47 фото, 1,2 ГБ».")
                        .font(F.sans(14)).foregroundColor(Theme.ink)
                }.padding(.vertical, 6).row()
                Toggle("Умная ночь", isOn: Binding(get: { settings.smartNight }, set: { on in
                    settings.smartNight = on
                    if on {
                        Task {
                            denied = !(await NightReport.requestPermission())
                            engine.scheduleBackground()
                        }
                    } else {
                        NightReport.cancel()
                        engine.scheduleBackground()
                    }
                })).row()
                if settings.smartNight {
                    Stepper(value: $settings.morningHour, in: 5...12) {
                        HStack {
                            Text("Утренний отчёт")
                            Spacer()
                            Text(String(format: "%02d:00", settings.morningHour)).font(F.mono(13)).foregroundColor(Theme.acc)
                        }
                    }.row()
                }
                if denied {
                    Text("Уведомления выключены — включите их в Настройках iPhone → ZALET.").font(F.sans(12)).foregroundColor(Theme.danger).row()
                }
            } header: { SectionHeader(text: "Умная ночь") } footer: {
                Hint(text: "Ночная выгрузка запускается после полуночи, когда iPhone на зарядке и в сети. Точное время выбирает iOS.")
            }

            Section {
                Toggle("Тактильный отклик", isOn: $settings.haptics).row()
                Toggle("Live Activity на экране блокировки", isOn: $settings.liveActivity).row()
            } header: { SectionHeader(text: "Отклик") } footer: {
                Hint(text: "Лёгкая отдача на каждый «залетевший» файл и прогресс выгрузки на экране блокировки и в Dynamic Island.")
            }
        }
        .navigationTitle("Умная ночь")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - После выгрузки

struct AfterSettings: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var engine: SyncEngine
    @State private var deletable: [String] = []
    @State private var counting = false
    @State private var confirm = false
    @State private var resultText: String?

    var body: some View {
        ThemedForm {
            Section {
                Toggle("Добавлять в альбом", isOn: $settings.addToAlbum).row()
                if settings.addToAlbum {
                    NamedField(title: "Название", text: $settings.albumNameAfter)
                }
            } header: { SectionHeader(text: "Отметка") } footer: {
                Hint(text: "Выгруженные снимки будут попадать в отдельный альбом — так видно, что уже на SSD.")
            }

            Section {
                Button {
                    Task {
                        counting = true
                        deletable = await engine.fullyUploadedAssetIDs()
                        counting = false
                        confirm = !deletable.isEmpty
                        if deletable.isEmpty { resultText = "Нечего удалять" }
                    }
                } label: {
                    HStack {
                        Text("Удалить выгруженное с iPhone").foregroundColor(Theme.danger)
                        Spacer()
                        if counting { ProgressView() }
                    }
                }.row()
                if let resultText { Text(resultText).font(F.sans(13)).foregroundColor(Theme.muted).row() }
            } header: { SectionHeader(text: "Освободить место") } footer: {
                Hint(text: "Удаляются только снимки, все части которых уже лежат на SSD. iOS попросит подтверждение, удалённое 30 дней хранится в «Недавно удалённых».")
            }
        }
        .navigationTitle("После выгрузки")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Удалить \(deletable.count) снимков с iPhone? На SSD они останутся.", isPresented: $confirm, titleVisibility: .visible) {
            Button("Удалить \(deletable.count)", role: .destructive) {
                Task {
                    let ok = await engine.deleteFromPhone(deletable)
                    resultText = ok ? "Удалено: \(deletable.count)" : "Удаление отменено"
                }
            }
            Button("Отмена", role: .cancel) {}
        }
    }
}

// MARK: - Обслуживание

struct MaintenanceSettings: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var store: SyncStore
    @EnvironmentObject var log: LogStore
    @State private var confirmReset = false
    @State private var info: String?

    var body: some View {
        ThemedForm {
            Section {
                Button("Сверить с роутером") {
                    Task {
                        do {
                            let items = try await ServerAPI.index()
                            let n = store.merge(server: items)
                            info = "На роутере \(items.count) файлов, добавлено в журнал: \(n)"
                        } catch { info = error.localizedDescription }
                    }
                }.row()
                Button("Повторить файлы с ошибками") {
                    store.clearFailed()
                    engine.start(reason: "повтор ошибок")
                    info = "Запущено"
                }.row()
                Button("Очистить временные файлы") {
                    engine.clearTemp()
                    info = "Временные файлы удалены"
                }.row()
                if let info { Text(info).font(F.sans(13)).foregroundColor(Theme.muted).row() }
            } header: { SectionHeader(text: "Журнал выгрузок") } footer: {
                Hint(text: "Приложение помнит, что уже выгружено, и перед каждым запуском сверяется с журналом роутера — повторов не будет даже после переустановки.")
            }

            Section {
                LabeledContent("Записей на iPhone") { Text("\(store.done.count)").font(F.mono(13)) }.row()
                LabeledContent("Объём") { Text(formatBytes(store.totalBytes)).font(F.mono(13)) }.row()
                LabeledContent("С ошибкой") { Text("\(store.failed.count)").font(F.mono(13)) }.row()
            } header: { SectionHeader(text: "Статистика") }

            Section {
                Button("Остановить все передачи", role: .destructive) { engine.stopAll() }.row()
                Button("Сбросить журнал на iPhone", role: .destructive) { confirmReset = true }.row()
            } header: { SectionHeader(text: "Осторожно") } footer: {
                Hint(text: "Сброс журнала не удаляет файлы с SSD. При следующем запуске приложение сверится с роутером и не станет выгружать повторно.")
            }
        }
        .navigationTitle("Обслуживание")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Сбросить журнал выгрузок на iPhone?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Сбросить", role: .destructive) { store.reset(); log.add("Журнал на iPhone сброшен", .warn) }
            Button("Отмена", role: .cancel) {}
        }
    }
}

struct AboutView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                MonoLabel(text: "О приложении", number: "05")
                ZaletWordmark(size: 54)
                Text("фото залетают на SSD").font(F.mono(13, 500)).foregroundColor(Theme.acc2)
                Text("Выгрузка фото и видео с iPhone на SSD домашнего роутера. Без облаков и подписок: файлы идут напрямую на ваш диск — дома или через Tailscale.")
                    .font(F.sans(15)).foregroundColor(Theme.muted)
                Panel {
                    MonoLabel(text: "Как это работает")
                    VStack(alignment: .leading, spacing: 8) {
                        Text("1. Приложение берёт по одному файлу из медиатеки — лишнее место на iPhone не нужно.")
                        Text("2. Отправляет его фоновой передачей iOS — она продолжается при свёрнутом приложении.")
                        Text("3. Сервер на роутере проверяет размер, кладёт файл по вашей раскладке и записывает в журнал.")
                        Text("4. Уже выгруженное больше не отправляется — ни с этого iPhone, ни после переустановки.")
                    }
                    .font(F.sans(13)).foregroundColor(Theme.ink).padding(.top, 10)
                }
                Panel {
                    MonoLabel(text: "Об авторе", number: "06")
                    HStack(spacing: 14) {
                        RoundedRectangle(cornerRadius: 10).fill(Theme.accGradient).frame(width: 44, height: 44)
                            .overlay(Text("ПМ").font(F.display(17, 800)).foregroundColor(Theme.bg))
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Андрей Подмарчук").font(F.display(17, 700)).foregroundColor(Theme.ink)
                            Text("Zaletniy · системный администратор").font(F.mono(11)).foregroundColor(Theme.muted)
                        }
                    }.padding(.top, 12)
                    Link(destination: URL(string: "https://apodmarchuk.ru")!) {
                        HStack {
                            Text("apodmarchuk.ru").font(F.mono(14, 600))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                        .foregroundColor(Theme.acc)
                        .padding(.horizontal, 16).padding(.vertical, 13)
                        .overlay(Capsule().stroke(Theme.acc.opacity(0.5), lineWidth: 1))
                    }
                    .padding(.top, 14)
                }
                Text("v2.0.0").font(F.mono(11)).foregroundColor(Theme.dim)
            }
            .padding(20)
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
    }
}
