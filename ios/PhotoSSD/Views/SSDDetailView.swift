import SwiftUI
import Photos
import AVKit

enum Restorer {
    enum Failure: LocalizedError {
        case denied, failed(String)
        var errorDescription: String? {
            switch self {
            case .denied: return "Нет доступа к медиатеке"
            case .failed(let m): return m
            }
        }
    }

    /// Вернуть файл с SSD в медиатеку iPhone. Live Photo собирается обратно вместе с видеочастью.
    @MainActor
    static func restore(_ item: SSDItem) async throws {
        let st = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard st == .authorized || st == .limited else { throw Failure.denied }

        let main = try await ServerAPI.download(item)
        var pair: URL?
        if let assetID = item.assetID, item.role == .photo || item.role == .photoEdited {
            let liveRole: ResourceRole = item.role == .photoEdited ? .liveVideoEdited : .liveVideo
            let stem = (item.name as NSString).deletingPathExtension
            let pairItem = SSDItem(id: SyncStore.key(assetID, liveRole), path: "\(stem).MOV", size: 0, time: item.time,
                                   date: item.date, kind: "livevideo", album: item.album, thumb: nil, trashed: nil)
            pair = try? await ServerAPI.download(pairItem)
        }

        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges({
                let req = PHAssetCreationRequest.forAsset()
                req.creationDate = item.takenDate
                let o = PHAssetResourceCreationOptions()
                o.originalFilename = item.name
                req.addResource(with: item.isVideo ? .video : .photo, fileURL: main, options: o)
                if let pair {
                    let o2 = PHAssetResourceCreationOptions()
                    o2.originalFilename = (item.name as NSString).deletingPathExtension + ".MOV"
                    req.addResource(with: .pairedVideo, fileURL: pair, options: o2)
                }
            }) { ok, err in
                if ok { c.resume() } else { c.resume(throwing: Failure.failed(err?.localizedDescription ?? "Не удалось сохранить")) }
            }
        }
    }
}

struct SSDDetailView: View {
    let item: SSDItem
    var onClose: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var log: LogStore

    @State private var image: UIImage?
    @State private var player: AVPlayer?
    @State private var loading = true
    @State private var error: String?
    @State private var busy: String?
    @State private var done: String?
    @State private var confirmTrash = false
    @State private var shareURL: URL?
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var showInfo = true

    private var onPhone: Bool {
        guard let id = item.assetID else { return false }
        return PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).count > 0
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
                .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { showInfo.toggle() } }
            VStack {
                topBar
                Spacer()
                if showInfo { bottomPanel.transition(.move(edge: .bottom).combined(with: .opacity)) }
            }
        }
        .preferredColorScheme(.dark)
        .task { await load() }
        .onDisappear { player?.pause() }
        .confirmationDialog("Переместить в корзину? Файл будет храниться в корзине роутера 30 дней.",
                            isPresented: $confirmTrash, titleVisibility: .visible) {
            Button("В корзину", role: .destructive) { Task { await trash() } }
            Button("Отмена", role: .cancel) {}
        }
        .sheet(item: Binding(get: { shareURL.map(ShareBox.init) }, set: { shareURL = $0?.url })) { box in
            ShareSheet(items: [box.url])
        }
    }

    @ViewBuilder private var content: some View {
        if let player {
            VideoPlayer(player: player).ignoresSafeArea()
        } else if let image {
            Image(uiImage: image).resizable().scaledToFit()
                .scaleEffect(scale)
                .gesture(MagnificationGesture()
                    .onChanged { v in scale = max(1, min(5, lastScale * v)) }
                    .onEnded { _ in lastScale = scale; if scale < 1.05 { withAnimation { scale = 1; lastScale = 1 } } })
                .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5; lastScale = scale } }
        } else if loading {
            VStack(spacing: 12) {
                ProgressView().tint(Theme.acc)
                Text("Загрузка с SSD…").font(F.mono(12)).foregroundColor(Theme.muted)
            }
        } else if let error {
            Text(error).font(F.sans(14)).foregroundColor(Theme.danger).padding()
        }
    }

    private var topBar: some View {
        HStack {
            Button { onClose(false); dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundColor(Theme.ink)
                    .frame(width: 40, height: 40).background(.ultraThinMaterial).clipShape(Circle())
            }
            Spacer()
            if showInfo {
                Text(item.takenDate.formatted(date: .abbreviated, time: .shortened))
                    .font(F.mono(12, 500)).foregroundColor(Theme.ink)
                    .padding(.horizontal, 12).padding(.vertical, 8).background(.ultraThinMaterial).clipShape(Capsule())
            }
        }
        .padding(.horizontal, 16)
    }

    private var bottomPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(item.name).font(F.display(16, 700)).foregroundColor(Theme.ink).lineLimit(1)
                Spacer()
                Label(onPhone ? "есть на iPhone" : "только на SSD", systemImage: onPhone ? "iphone" : "externaldrive.fill")
                    .font(F.mono(10, 500)).foregroundColor(onPhone ? Theme.muted : Theme.acc2)
            }
            Text("/" + item.path).font(F.mono(11)).foregroundColor(Theme.muted).lineLimit(2)
            HStack(spacing: 14) {
                Text(formatBytes(item.size)).font(F.mono(11)).foregroundColor(Theme.dim)
                if let album = item.album, !album.isEmpty {
                    Label(album, systemImage: "rectangle.stack").font(F.mono(11)).foregroundColor(Theme.dim)
                }
            }
            if let busy {
                HStack(spacing: 8) { ProgressView().tint(Theme.acc); Text(busy).font(F.sans(13)).foregroundColor(Theme.ink) }
            } else if let done {
                Label(done, systemImage: "checkmark.circle.fill").font(F.sans(13, 600)).foregroundColor(Theme.live)
            }
            HStack(spacing: 10) {
                Button { Task { await restore() } } label: { Label("В медиатеку", systemImage: "square.and.arrow.down") }
                    .buttonStyle(AccentButtonStyle())
                Button { Task { await share() } } label: { Image(systemName: "square.and.arrow.up") }
                    .buttonStyle(AccentButtonStyle(filled: false)).frame(width: 64)
                Button { confirmTrash = true } label: { Image(systemName: "trash") }
                    .buttonStyle(AccentButtonStyle(filled: false)).frame(width: 64)
            }
            .disabled(busy != nil)
        }
        .padding(18)
        .background(Theme.panel.opacity(0.94))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Theme.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .padding(.horizontal, 10).padding(.bottom, 6)
    }

    private func load() async {
        defer { loading = false }
        if item.isVideo {
            if let asset = VideoThumb.asset(for: item) {
                let p = AVPlayer(playerItem: AVPlayerItem(asset: asset))
                player = p
                p.play()
            }
            return
        }
        // Сначала превью, затем оригинал
        image = await ThumbLoader.shared.image(for: item)
        do {
            let url = try await ServerAPI.download(item)
            if let full = ThumbLoader.downscale(url: url, max: 3000) { image = full }
        } catch { if image == nil { self.error = error.localizedDescription } }
    }

    private func restore() async {
        busy = "Возвращаю в медиатеку…"
        done = nil
        do {
            try await Restorer.restore(item)
            done = "Сохранено в медиатеку"
            log.add("Возвращено на iPhone: \(item.name)", .ok)
            Haptics.finished()
        } catch {
            done = nil
            self.error = error.localizedDescription
            log.add("Не удалось вернуть \(item.name): \(error.localizedDescription)", .error)
        }
        busy = nil
    }

    private func share() async {
        busy = "Готовлю файл…"
        shareURL = try? await ServerAPI.download(item)
        busy = nil
    }

    private func trash() async {
        busy = "Перемещаю в корзину…"
        do {
            try await ServerAPI.moveToTrash(item)
            log.add("В корзину: \(item.name)", .warn)
            Haptics.tap()
            onClose(true)
            dismiss()
        } catch { self.error = error.localizedDescription }
        busy = nil
    }
}

struct ShareBox: Identifiable { let url: URL; var id: String { url.path } }

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: - Корзина

struct TrashView: View {
    @EnvironmentObject var log: LogStore
    @State private var items: [SSDItem] = []
    @State private var days = 30
    @State private var loading = true
    @State private var error: String?
    @State private var confirmEmpty = false
    @State private var confirmDelete: SSDItem?

    private var totalBytes: Int64 { items.reduce(0) { $0 + $1.size } }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(items.count) \(NightReport.plural(items.count, "файл", "файла", "файлов")) · \(formatBytes(totalBytes))")
                        .font(F.display(20, 700)).foregroundColor(Theme.ink)
                    Text("Удалённое хранится \(days) дней, потом стирается автоматически.")
                        .font(F.sans(13)).foregroundColor(Theme.muted)
                }
                .padding(.vertical, 6)
                .listRowBackground(Theme.panel)
            }
            if let error { Text(error).foregroundColor(Theme.danger).listRowBackground(Theme.panel) }
            Section {
                ForEach(items) { it in
                    HStack(spacing: 12) {
                        SSDThumb(item: it).frame(width: 54, height: 54).clipShape(RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(it.name).font(F.sans(14, 500)).foregroundColor(Theme.ink).lineLimit(1)
                            Text(leftText(it)).font(F.mono(11)).foregroundColor(Theme.acc2)
                            Text(formatBytes(it.size)).font(F.mono(10)).foregroundColor(Theme.dim)
                        }
                        Spacer()
                    }
                    .listRowBackground(Theme.panel)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { confirmDelete = it } label: { Label("Удалить", systemImage: "trash.slash") }
                    }
                    .swipeActions(edge: .leading) {
                        Button { Task { await restore(it) } } label: { Label("Вернуть", systemImage: "arrow.uturn.backward") }
                            .tint(Theme.live)
                    }
                    .contextMenu {
                        Button { Task { await restore(it) } } label: { Label("Вернуть на SSD", systemImage: "arrow.uturn.backward") }
                        Button(role: .destructive) { confirmDelete = it } label: { Label("Удалить навсегда", systemImage: "trash.slash") }
                    }
                }
            } footer: {
                if !items.isEmpty { Hint(text: "Смахните вправо — вернуть, влево — удалить навсегда.") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .overlay { if loading && items.isEmpty { ProgressView().tint(Theme.acc) } }
        .navigationTitle("Корзина")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Очистить", role: .destructive) { confirmEmpty = true }
                    .foregroundColor(Theme.danger).disabled(items.isEmpty)
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog("Очистить корзину? \(items.count) файлов будут удалены с SSD навсегда.",
                            isPresented: $confirmEmpty, titleVisibility: .visible) {
            Button("Удалить навсегда", role: .destructive) {
                Task {
                    do { try await ServerAPI.emptyTrash(); log.add("Корзина очищена", .warn); await load() }
                    catch { self.error = error.localizedDescription }
                }
            }
            Button("Отмена", role: .cancel) {}
        }
        .confirmationDialog("Удалить навсегда?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible) {
            Button("Удалить", role: .destructive) {
                if let it = confirmDelete {
                    Task {
                        do { try await ServerAPI.deleteForever(it.id); items.removeAll { $0.id == it.id } }
                        catch { self.error = error.localizedDescription }
                    }
                }
            }
            Button("Отмена", role: .cancel) {}
        }
    }

    private func leftText(_ it: SSDItem) -> String {
        let trashed = Date(timeIntervalSince1970: TimeInterval(it.trashed ?? 0))
        let left = max(0, days - (Calendar.current.dateComponents([.day], from: trashed, to: Date()).day ?? 0))
        return "удалится через \(left) \(NightReport.plural(left, "день", "дня", "дней"))"
    }

    private func load() async {
        loading = true
        do { let r = try await ServerAPI.trashList(); items = r.items; days = r.days; error = nil }
        catch { self.error = error.localizedDescription }
        loading = false
    }

    private func restore(_ it: SSDItem) async {
        do {
            try await ServerAPI.restoreFromTrash(it.id)
            items.removeAll { $0.id == it.id }
            log.add("Возвращено из корзины: \(it.name)", .ok)
            Haptics.tap()
        } catch { self.error = error.localizedDescription }
    }
}
