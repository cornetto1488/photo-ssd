import SwiftUI
import Photos
import AVKit

enum SSDMode: String, CaseIterable, Identifiable { case feed = "Лента", folders = "Папки"; var id: String { rawValue } }

struct FeedSection: Identifiable {
    let title: String
    let items: [SSDItem]
    var id: String { title }
}

@MainActor
final class SSDFeedModel: ObservableObject {
    @Published var items: [SSDItem] = []
    @Published var total = 0
    @Published var loading = false
    @Published var error: String?
    @Published var filter = SSDFilter()
    @Published var albums: [SSDAlbum] = []

    func reload() async {
        loading = true
        error = nil
        do {
            let page = try await ServerAPI.items(filter, offset: 0)
            items = page.items
            total = page.total
        } catch { self.error = error.localizedDescription }
        loading = false
        if albums.isEmpty { albums = (try? await ServerAPI.albums()) ?? [] }
    }

    func loadMoreIfNeeded(_ item: SSDItem) async {
        guard !loading, items.count < total, item.id == items.last?.id else { return }
        loading = true
        if let page = try? await ServerAPI.items(filter, offset: items.count) {
            items += page.items
        }
        loading = false
    }

    /// Группы по месяцам съёмки.
    var sections: [FeedSection] {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ru_RU")
        f.dateFormat = "LLLL yyyy"
        var order: [String] = []
        var map: [String: [SSDItem]] = [:]
        for it in items {
            let k = f.string(from: it.takenDate).capitalized
            if map[k] == nil { order.append(k) }
            map[k, default: []].append(it)
        }
        return order.map { FeedSection(title: $0, items: map[$0] ?? []) }
    }

    func remove(_ item: SSDItem) {
        items.removeAll { $0.id == item.id }
        total = max(0, total - 1)
    }
}

struct SSDView: View {
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var feed = SSDFeedModel()
    @State private var mode: SSDMode = .feed
    @State private var showFilter = false
    @State private var opened: SSDItem?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $mode) {
                    ForEach(SSDMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.vertical, 10)

                if !engine.serverOnline {
                    OfflineNotice()
                } else if mode == .feed {
                    feedView
                } else {
                    FolderView(dir: "", opened: $opened)
                }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("SSD")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    NavigationLink { TrashView() } label: { Image(systemName: "trash") }
                }
                if mode == .feed {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showFilter = true } label: {
                            Image(systemName: feed.filter.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        }
                    }
                }
            }
            .searchable(text: $feed.filter.query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Имя файла или альбом")
            .onSubmit(of: .search) { Task { await feed.reload() } }
            .onChange(of: feed.filter.query) { q in if q.isEmpty { Task { await feed.reload() } } }
            .task { if feed.items.isEmpty { await feed.reload() } }
            .sheet(isPresented: $showFilter) {
                SSDFilterSheet(filter: $feed.filter, albums: feed.albums) { Task { await feed.reload() } }
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(item: $opened) { item in
                SSDDetailView(item: item) { removed in if removed { feed.remove(item) } }
            }
        }
    }

    private var feedView: some View {
        ScrollView {
            HStack {
                Text("\(feed.total) \(NightReport.plural(feed.total, "файл", "файла", "файлов"))")
                    .font(F.mono(11, 500)).foregroundColor(Theme.muted)
                if feed.filter.isActive {
                    Button("сбросить фильтр") { feed.filter = SSDFilter(); Task { await feed.reload() } }
                        .font(F.mono(11, 500)).foregroundColor(Theme.acc)
                }
                Spacer()
            }
            .padding(.horizontal, 16)

            if let err = feed.error {
                Text(err).font(F.sans(13)).foregroundColor(Theme.danger).padding()
            }
            LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                ForEach(feed.sections) { section in
                    Section {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 4), spacing: 2) {
                            ForEach(section.items) { it in
                                SSDThumb(item: it)
                                    .onTapGesture { opened = it }
                                    .task { await feed.loadMoreIfNeeded(it) }
                            }
                        }
                    } header: {
                        Text(section.title.uppercased())
                            .font(F.mono(11, 600)).tracking(1.2).foregroundColor(Theme.ink)
                            .padding(.horizontal, 16).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.bg.opacity(0.92))
                    }
                }
            }
            if feed.loading { ProgressView().tint(Theme.acc).padding() }
        }
        .refreshable { await feed.reload() }
    }
}

struct OfflineNotice: View {
    var body: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "wifi.exclamationmark").font(.system(size: 36)).foregroundColor(Theme.acc)
            Text("Нет связи с роутером").font(F.display(20, 700)).foregroundColor(Theme.ink)
            Text("Подключитесь к домашнему Wi-Fi или включите Tailscale").font(F.sans(14)).foregroundColor(Theme.muted)
                .multilineTextAlignment(.center)
            Spacer()
        }.padding()
    }
}

// MARK: - Папки

struct FolderView: View {
    let dir: String
    @Binding var opened: SSDItem?
    @State private var entries: [SSDEntry] = []
    @State private var loading = true
    @State private var error: String?

    private var folders: [SSDEntry] { entries.filter(\.isDir) }
    private var files: [SSDEntry] { entries.filter { !$0.isDir } }

    var body: some View {
        ScrollView {
            if !dir.isEmpty {
                Text("/" + dir).font(F.mono(12)).foregroundColor(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 6)
            }
            if let error { Text(error).font(F.sans(13)).foregroundColor(Theme.danger).padding() }
            VStack(spacing: 8) {
                ForEach(folders) { f in
                    NavigationLink {
                        FolderView(dir: f.path, opened: $opened)
                            .background(Theme.bg.ignoresSafeArea())
                            .navigationTitle(f.name)
                            .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "folder.fill").foregroundColor(Theme.acc).font(.system(size: 20))
                            Text(f.name).font(F.sans(15, 500)).foregroundColor(Theme.ink)
                            Spacer()
                            Text("\(f.count ?? 0)").font(F.mono(12)).foregroundColor(Theme.muted)
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundColor(Theme.dim)
                        }
                        .padding(14)
                        .background(Theme.panel)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
            }
            .padding(.horizontal, 16)

            if !files.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 4), spacing: 2) {
                    ForEach(files) { e in
                        SSDThumb(item: e.asItem).onTapGesture { opened = e.asItem }
                    }
                }
                .padding(.top, 8)
            }
            if loading { ProgressView().tint(Theme.acc).padding() }
            if !loading && entries.isEmpty && error == nil {
                Text("Папка пуста").font(F.sans(14)).foregroundColor(Theme.muted).padding(40)
            }
        }
        .refreshable { await load() }
        .task { if entries.isEmpty { await load() } }
    }

    private func load() async {
        loading = true
        do { entries = try await ServerAPI.browse(dir); error = nil }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Плитка

struct SSDThumb: View {
    let item: SSDItem
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .bottomLeading) {
                Group {
                    if let image { Image(uiImage: image).resizable().scaledToFill() }
                    else {
                        ZStack {
                            Theme.panel
                            Image(systemName: item.isVideo ? "video" : "photo").foregroundColor(Theme.dim)
                        }
                    }
                }
                .frame(width: g.size.width, height: g.size.width).clipped()
                if item.isVideo {
                    Image(systemName: "play.fill").font(.system(size: 10, weight: .bold)).foregroundColor(.white)
                        .padding(5).background(.black.opacity(0.45)).clipShape(Circle()).padding(4)
                } else if item.kind == "live" {
                    Image(systemName: "livephoto").font(.system(size: 11, weight: .semibold)).foregroundColor(.white)
                        .padding(4).shadow(radius: 2)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .task(id: item.id) { image = await ThumbLoader.shared.image(for: item) }
    }
}

// MARK: - Фильтры

struct SSDFilterSheet: View {
    @Binding var filter: SSDFilter
    let albums: [SSDAlbum]
    var apply: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var useFrom = false
    @State private var useTo = false
    @State private var from = Calendar.current.date(byAdding: .month, value: -1, to: Date())!
    @State private var to = Date()

    var body: some View {
        NavigationStack {
            ThemedForm {
                Section {
                    Picker("Тип", selection: $filter.kind) {
                        Text("Все").tag(String?.none)
                        Text("Фото").tag(String?.some("photo"))
                        Text("Live Photo").tag(String?.some("live"))
                        Text("Видео").tag(String?.some("video"))
                        Text("Скриншоты").tag(String?.some("screenshot"))
                    }.row()
                    Picker("Альбом", selection: $filter.album) {
                        Text("Любой").tag(String?.none)
                        ForEach(albums) { a in Text("\(a.name) · \(a.count)").tag(String?.some(a.name)) }
                    }.row()
                } header: { SectionHeader(text: "Что") }

                Section {
                    Toggle("С даты", isOn: $useFrom).row()
                    if useFrom { DatePicker("С", selection: $from, displayedComponents: .date).row() }
                    Toggle("По дату", isOn: $useTo).row()
                    if useTo { DatePicker("По", selection: $to, displayedComponents: .date).row() }
                    HStack(spacing: 8) {
                        QuickRange(title: "Сегодня") { setRange(days: 0) }
                        QuickRange(title: "Неделя") { setRange(days: 7) }
                        QuickRange(title: "Месяц") { setRange(days: 30) }
                        QuickRange(title: "Год") { setRange(days: 365) }
                    }.row()
                } header: { SectionHeader(text: "Когда снято") }
                .environment(\.locale, Locale(identifier: "ru_RU"))

                Section {
                    Button("Сбросить всё", role: .destructive) {
                        filter = SSDFilter(); useFrom = false; useTo = false
                    }.row()
                }
            }
            .navigationTitle("Фильтр")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Показать") {
                        filter.from = useFrom ? Calendar.current.startOfDay(for: from) : nil
                        filter.to = useTo ? Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: to)) : nil
                        apply(); dismiss()
                    }
                }
            }
            .onAppear {
                if let f = filter.from { useFrom = true; from = f }
                if let t = filter.to { useTo = true; to = t.addingTimeInterval(-1) }
            }
        }
    }

    private func setRange(days: Int) {
        useFrom = true; useTo = false
        from = Calendar.current.date(byAdding: .day, value: -days, to: Calendar.current.startOfDay(for: Date()))!
    }
}

struct QuickRange: View {
    let title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(F.mono(11, 500)).foregroundColor(Theme.acc)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .overlay(Capsule().stroke(Theme.acc.opacity(0.5), lineWidth: 1))
        }.buttonStyle(.plain)
    }
}
