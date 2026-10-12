import SwiftUI
import UIKit
import CoreText

// Палитра и шрифты в стиле apodmarchuk.ru
enum Theme {
    static let bg      = Color(hex: 0x08080A)
    static let bg2     = Color(hex: 0x0C0C0F)
    static let panel   = Color(hex: 0x121216)
    static let panel2  = Color(hex: 0x17171C)
    static let line    = Color(hex: 0xF2F0ED).opacity(0.09)
    static let line2   = Color(hex: 0xF2F0ED).opacity(0.18)
    static let ink     = Color(hex: 0xF2F0ED)
    static let muted   = Color(hex: 0x8C8C96)
    static let dim     = Color(hex: 0x5B5B64)
    static let acc     = Color(hex: 0xFF5A1F)
    static let acc2    = Color(hex: 0xFF8A4C)
    static let live    = Color(hex: 0x3BE08C)
    static let danger  = Color(hex: 0xFF4D4D)

    static let accGradient = LinearGradient(colors: [acc2, acc], startPoint: .topLeading, endPoint: .bottomTrailing)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: alpha)
    }
}

// Шрифты: Onest (заголовки), Inter (текст), JetBrains Mono (подписи).
// Файлы вариативные, поэтому толщину задаём через ось 'wght'.
enum F {
    private static let wghtAxis = 0x77676874 // 'wght'

    private static func uiFont(_ family: String, _ size: CGFloat, _ weight: CGFloat) -> UIFont {
        let attrs: [UIFontDescriptor.AttributeName: Any] = [
            .family: family,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [wghtAxis: weight]
        ]
        let font = UIFont(descriptor: UIFontDescriptor(fontAttributes: attrs), size: size)
        if font.familyName == family { return font }
        return UIFont.systemFont(ofSize: size, weight: weight >= 700 ? .heavy : (weight >= 500 ? .semibold : .regular))
    }

    static func display(_ size: CGFloat, _ weight: CGFloat = 800) -> Font { Font(uiFont("Onest", size, weight)) }
    static func sans(_ size: CGFloat, _ weight: CGFloat = 400) -> Font { Font(uiFont("Inter", size, weight)) }
    static func mono(_ size: CGFloat, _ weight: CGFloat = 400) -> Font { Font(uiFont("JetBrains Mono", size, weight)) }

    static func uiDisplay(_ size: CGFloat, _ weight: CGFloat = 700) -> UIFont { uiFont("Onest", size, weight) }
    static func uiSans(_ size: CGFloat, _ weight: CGFloat = 400) -> UIFont { uiFont("Inter", size, weight) }
}

// Подпись в стиле сайта: "// 01 ЗАГОЛОВОК"
struct MonoLabel: View {
    let text: String
    var number: String? = nil
    var color: Color = Theme.muted
    var body: some View {
        HStack(spacing: 6) {
            if let number { Text("// \(number)").foregroundColor(Theme.acc) }
            Text(text.uppercased()).foregroundColor(color)
        }
        .font(F.mono(11, 500))
        .tracking(1.2)
    }
}

// Надпись-логотип: "ZA" акцентным градиентом, "LET" — светлым.
struct ZaletWordmark: View {
    var size: CGFloat = 20
    var body: some View {
        HStack(spacing: 0) {
            Text("ZA").foregroundStyle(Theme.accGradient)
            Text("LET").foregroundColor(Theme.ink)
        }
        .font(F.display(size, 800))
        .tracking(size * 0.02)
    }
}

struct Panel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panel)
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.line, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

struct AccentButtonStyle: ButtonStyle {
    var filled = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(F.sans(16, 600))
            .foregroundColor(filled ? Theme.bg : Theme.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                Group {
                    if filled { Theme.accGradient } else { Theme.panel2 }
                }
            )
            .overlay(Capsule().stroke(filled ? Color.clear : Theme.line2, lineWidth: 1))
            .clipShape(Capsule())
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct StatusDot: View {
    var color: Color
    @State private var pulse = false
    var body: some View {
        ZStack {
            Circle().fill(color.opacity(0.35)).frame(width: 14, height: 14)
                .scaleEffect(pulse ? 1.4 : 0.8).opacity(pulse ? 0 : 1)
            Circle().fill(color).frame(width: 7, height: 7)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulse = true }
        }
    }
}

func formatBytes(_ b: Int64) -> String {
    let f = ByteCountFormatter()
    f.countStyle = .file
    f.allowedUnits = [.useKB, .useMB, .useGB, .useTB]
    return f.string(fromByteCount: b)
}

func applyGlobalAppearance() {
    let nav = UINavigationBarAppearance()
    nav.configureWithOpaqueBackground()
    nav.backgroundColor = UIColor(Theme.bg)
    nav.shadowColor = .clear
    nav.titleTextAttributes = [.foregroundColor: UIColor(Theme.ink), .font: F.uiDisplay(17, 700)]
    nav.largeTitleTextAttributes = [.foregroundColor: UIColor(Theme.ink), .font: F.uiDisplay(32, 800)]
    UINavigationBar.appearance().standardAppearance = nav
    UINavigationBar.appearance().scrollEdgeAppearance = nav
    UINavigationBar.appearance().compactAppearance = nav
    UINavigationBar.appearance().tintColor = UIColor(Theme.acc)

    let tab = UITabBarAppearance()
    tab.configureWithOpaqueBackground()
    tab.backgroundColor = UIColor(Theme.bg2)
    tab.shadowColor = UIColor(Theme.line)
    UITabBar.appearance().standardAppearance = tab
    UITabBar.appearance().scrollEdgeAppearance = tab

    UITableView.appearance().backgroundColor = .clear
    UISwitch.appearance().onTintColor = UIColor(Theme.acc)
}
