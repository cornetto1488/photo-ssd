import SwiftUI
import Photos

enum LibFilter: String, CaseIterable, Identifiable {
    case all = "Все", done = "На SSD", pending = "Не выгружено", failed = "Ошибки"
    var id: String { rawValue }
}

@MainActor
final class LibraryModel: ObservableObject {
    @Published var assets: [PHAsset] = []
    @Published var loading = false
    let imageManager = PHCachingImageManager()

    func load() {
        loading = true
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        Task.detached {
            let res = PHAsset.fetchAssets(with: opts)
            var arr: [PHAsset] = []
            arr.reserveCapacity(res.count)
            res.enumerateObjects { a, _, _ in arr.append(a) }
            await MainActor.run {
                self.assets = arr
                self.loading = false
            }
        }
    }
}

struct LibraryView: View {
    @EnvironmentObject var store: SyncStore
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var model = LibraryModel()
    @State private var filter: LibFilter = .all
    @State private var selected: PHAsset?

    private var doneIDs: Set<String> { store.doneAssetIDs }
    private var failedIDs: Set<String> { store.failedAssetIDs }
    private var queuedIDs: Set<String> {
        Set((engine.queuedKeys.union(engine.inflightKeys)).map(SyncStore.assetID(fromKey:)))
    }

    private var filtered: [PHAsset] {
        switch filter {
        case .all: return model.assets
        case .done: return model.assets.filter { doneIDs.contains($0.localIdentifier) }
        case .pending: return model.assets.filter { !doneIDs.contains($0.localIdentifier) }
        case .failed: return model.assets.filter { failedIDs.contains($0.localIdentifier) && !doneIDs.contains($0.localIdentifier) }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                summary
                Picker("", selection: $filter) {
                    ForEach(LibFilter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.vertical, 10)

                if model.loading {
                    Spacer(); ProgressView().tint(Theme.acc); Spacer()
                } else {
                    ScrollView {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 4), spacing: 2) {
                            ForEach(filtered, id: \.localIdentifier) { a in
                                Thumb(asset: a, manager: model.imageManager, status: status(of: a))
                                    .onTapGesture { selected = a }
                            }
                        }
                    }
                }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Медиатека")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { if model.assets.isEmpty { model.load() } }
            .sheet(item: Binding(get: { selected.map(AssetBox.init) }, set: { selected = $0?.asset })) { box in
                AssetDetail(asset: box.asset).presentationDetents([.medium])
            }
        }
    }

    private var summary: some View {
        let total = model.assets.count
        let done = model.assets.filter { doneIDs.contains($0.localIdentifier) }.count
        return HStack(spacing: 18) {
            SummaryItem(value: "\(done)", label: "на SSD", color: Theme.live)
            SummaryItem(value: "\(max(0, total - done))", label: "осталось", color: Theme.acc)
            SummaryItem(value: "\(total)", label: "всего", color: Theme.ink)
            Spacer()
        }
        .padding(.horizontal, 16).padding(.top, 12)
    }

    private func status(of a: PHAsset) -> ThumbStatus {
        let id = a.localIdentifier
        if doneIDs.contains(id) { return .done }
        if queuedIDs.contains(id) { return .queued }
        if failedIDs.contains(id) { return .failed }
        return .none
    }
}

struct AssetBox: Identifiable { let asset: PHAsset; var id: String { asset.localIdentifier } }

struct SummaryItem: View {
    let value: String, label: String, color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(F.display(22, 800)).foregroundColor(color)
            Text(label.uppercased()).font(F.mono(9, 500)).tracking(1).foregroundColor(Theme.muted)
        }
    }
}

enum ThumbStatus { case none, done, queued, failed }

struct Thumb: View {
    let asset: PHAsset
    let manager: PHCachingImageManager
    let status: ThumbStatus
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let image { Image(uiImage: image).resizable().scaledToFill() }
                    else { Theme.panel }
                }
                .frame(width: g.size.width, height: g.size.width)
                .clipped()

                if asset.mediaType == .video {
                    Text(durationText).font(F.mono(9, 600)).foregroundColor(.white)
                        .padding(3).background(.black.opacity(0.5)).clipShape(RoundedRectangle(cornerRadius: 3))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading).padding(4)
                }
                badge.padding(4)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .onAppear(perform: load)
    }

    private var durationText: String {
        let s = Int(asset.duration)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    @ViewBuilder private var badge: some View {
        switch status {
        case .done:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 16, weight: .bold))
                .foregroundStyle(Theme.bg, Theme.live)
        case .queued:
            Image(systemName: "clock.fill").font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.acc).padding(2).background(Circle().fill(Theme.bg.opacity(0.7)))
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 14, weight: .bold))
                .foregroundStyle(Theme.danger).padding(2).background(Circle().fill(Theme.bg.opacity(0.7)))
        case .none:
            EmptyView()
        }
    }

    private func load() {
        guard image == nil else { return }
        let o = PHImageRequestOptions()
        o.deliveryMode = .opportunistic
        o.isNetworkAccessAllowed = true
        o.resizeMode = .fast
        manager.requestImage(for: asset, targetSize: CGSize(width: 220, height: 220), contentMode: .aspectFill, options: o) { img, _ in
            if let img { image = img }
        }
    }
}

struct AssetDetail: View {
    let asset: PHAsset
    @EnvironmentObject var store: SyncStore
    @EnvironmentObject var engine: SyncEngine
    @State private var preview: UIImage?

    private var doneRoles: [ResourceRole] {
        ResourceRole.allCases.filter { store.done[SyncStore.key(asset.localIdentifier, $0)] != nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 14) {
                    Group {
                        if let preview { Image(uiImage: preview).resizable().scaledToFill() } else { Theme.panel }
                    }
                    .frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(asset.creationDate?.formatted(date: .long, time: .shortened) ?? "Без даты")
                            .font(F.display(17, 700)).foregroundColor(Theme.ink)
                        Text(kindTitle).font(F.mono(11, 500)).foregroundColor(Theme.muted)
                        if doneRoles.isEmpty {
                            Label("Ещё не выгружено", systemImage: "icloud.slash").font(F.sans(13)).foregroundColor(Theme.acc)
                        } else {
                            Label("На SSD", systemImage: "checkmark.circle.fill").font(F.sans(13, 600)).foregroundColor(Theme.live)
                        }
                    }
                }
                ForEach(doneRoles, id: \.self) { role in
                    if let rec = store.done[SyncStore.key(asset.localIdentifier, role)] {
                        Panel {
                            MonoLabel(text: roleTitle(role))
                            Text("/" + rec.path).font(F.mono(12)).foregroundColor(Theme.ink).padding(.top, 6).textSelection(.enabled)
                            Text("\(formatBytes(rec.size)) · \(rec.date.formatted(date: .abbreviated, time: .shortened))")
                                .font(F.mono(11)).foregroundColor(Theme.muted).padding(.top, 4)
                        }
                    }
                }
                if let err = ResourceRole.allCases.compactMap({ store.failed[SyncStore.key(asset.localIdentifier, $0)] }).first {
                    Panel {
                        MonoLabel(text: "Ошибка", color: Theme.danger)
                        Text(err).font(F.sans(13)).foregroundColor(Theme.ink).padding(.top, 6)
                    }
                }
            }
            .padding(20)
        }
        .background(Theme.bg.ignoresSafeArea())
        .onAppear {
            let o = PHImageRequestOptions(); o.isNetworkAccessAllowed = true
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 300, height: 300), contentMode: .aspectFill, options: o) { img, _ in
                if let img { preview = img }
            }
        }
    }

    private var kindTitle: String {
        switch SyncEngine.kind(of: asset) {
        case .photo: return "ФОТО"
        case .live: return "LIVE PHOTO"
        case .video: return "ВИДЕО"
        case .screenshot: return "СКРИНШОТ"
        }
    }

    private func roleTitle(_ r: ResourceRole) -> String {
        switch r {
        case .photo: return "Фото"
        case .photoEdited: return "Фото с правками"
        case .liveVideo: return "Видео Live Photo"
        case .liveVideoEdited: return "Видео Live с правками"
        case .video: return "Видео"
        case .videoEdited: return "Видео с правками"
        }
    }
}
