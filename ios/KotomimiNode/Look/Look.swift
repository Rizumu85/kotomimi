import SwiftUI
import UIKit

/// The look, as the Android app has it (android/app/src/main/res/values*/colors.xml and Look.kt): the OriginOS 1.0
/// desktop the owner pointed to, in the apricot-and-mint family — a pale wall with two soft fields coloured by what
/// the device is doing, warm white widgets, small flat objects that stand for what each widget does. At night,
/// neutral blacks lit by the colour of the work, after Folia. Where iOS has a control of its own (the switch, the
/// sheets, the round keys) its Liquid Glass one is used.
nonisolated enum Palette {
    static let wall = Color(day: 0xF2EFE8, night: 0x070708)
    static let mintPale = Color(day: 0xDCEAE2, night: 0x4E9A7E)
    static let mint = Color(day: 0xCFE7DA, night: 0x3FB088)
    static let blue = Color(day: 0xDCE6EE, night: 0x4F7A94)
    static let tile = Color(day: 0xFFFDF8, night: 0x26262A)
    static let card = Color(day: 0xF5F2EB, night: 0x303035)
    static let tileFront = Color(day: 0xFFFFFF, night: 0x3A3A40)
    /// A hairline round a widget: nothing by day, a glint of its rim by night.
    static let tileEdge = Color(uiColor: UIColor { @Sendable traits in traits.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.06) : .clear })
    static let cardLine = Color(day: 0xE7E1D6, night: 0x3D3D44)
    static let waterTile = Color(day: 0x22343F, night: 0x26262A)
    static let water = Color(day: 0x7FD3AE, night: 0x8FE3BE)
    static let waterDeep = Color(day: 0x3E8F74, night: 0x3F8F72)
    static let waterNumber = Color(day: 0xEAF2EE, night: 0xF5F5F7)
    static let waterSub = Color(day: 0xA9BDC4, night: 0x9C9CA4)
    static let lens = Color(day: 0x2A3238, night: 0x070708)
    static let lensInner = Color(day: 0x3E4A52, night: 0x3A3A40)
    static let dial = Color(day: 0xF4F2EE, night: 0x2E2E33)
    static let dialEdge = Color(day: 0xE3DFD7, night: 0x4A4A52)
    static let dialHand = Color(day: 0x1F2A30, night: 0xE8E8EC)
    static let key = Color(day: 0xE86A52, night: 0xF2F2F4)
    static let inkRed = Color(day: 0xE35D45, night: 0xFF8A80)
    static let ink = Color(day: 0x1F2A30, night: 0xF5F5F7)
    static let ink2 = Color(day: 0x5F6B72, night: 0xA3A3AB)
    static let ink3 = Color(day: 0x8A949A, night: 0x6F6F78)
    static let good = Color(day: 0x2F8457, night: 0xA3E8C8)
    static let dot = Color(day: 0x283446, night: 0xDADAE2)
    /// The switch when on: the key's coral by day; by night the work's accent, as Folia takes the album's.
    static let accent = Color(day: 0xE86A52, night: 0x8FE3BE)
    /// The status word over the title: the key's red by day, white by night.
    static let kicker = Color(day: 0xE35D45, night: 0xF5F5F7)
}

/// The system resolves a colour wherever it draws, the render thread included: nothing here belongs to the main actor.
nonisolated extension Color {
    init(day: UInt32, night: UInt32) {
        self.init(uiColor: UIColor { @Sendable traits in
            let hex = traits.userInterfaceStyle == .dark ? night : day
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
}

/// A widget: warm white, its corners round, as the Android app draws it. (Glass over the wall made it look out of
/// focus: the system's own controls carry the glass instead.)
struct Tile<Content: View>: View {
    var padding: CGFloat = 20
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Palette.tile.opacity(0.84), in: .rect(cornerRadius: Metrics.radius))
            .overlay(RoundedRectangle(cornerRadius: Metrics.radius).stroke(Palette.tileEdge, lineWidth: 0.5))
            .covers()
    }
}

// ── The objects ─────────────────────────────────────────────────────────────────────────────────────────────

/// Hearing: a glass of water, dark with the water's mint in its lower part.
struct WaterThing: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: s * 0.2).fill(scheme == .dark ? Palette.dial : Palette.waterTile)
                Palette.water.frame(height: s * 0.92 * 0.42).shadow(color: scheme == .dark ? Palette.water.opacity(0.6) : .clear, radius: s * 0.12)
            }
            .clipShape(.rect(cornerRadius: s * 0.2))
            .overlay(RoundedRectangle(cornerRadius: s * 0.2).stroke(scheme == .dark ? Palette.dialEdge : .clear, lineWidth: 1.3))
            .frame(width: s * 0.74, height: s * 0.92)
            .frame(width: box.size.width, height: box.size.height)
        }
    }
}

/// The devices: a camera's lens, its centre lit while a computer is at work with the device.
struct LensThing: View {
    var lit: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            ZStack {
                if scheme == .dark {
                    // The night draws an object as a face a shade lighter than the widget, with a lighter rim, and
                    // the light only where it gives it (`night` in Look.kt).
                    Circle().fill(Palette.dial).overlay(Circle().stroke(Palette.dialEdge, lineWidth: 1.3)).frame(width: s * 0.88)
                    Circle().stroke(Palette.dialEdge, lineWidth: 1.3).frame(width: s * 0.54)
                    Circle().fill(lit ? Palette.water : Palette.dialEdge).frame(width: s * 0.22)
                        .shadow(color: lit ? Palette.water : .clear, radius: s * 0.18)
                } else {
                    Circle().fill(Palette.lens).frame(width: s * 0.92).shadow(color: .black.opacity(0.24), radius: 3, y: 2)
                    Circle().fill(Palette.lensInner).frame(width: s * 0.58)
                    Circle().fill(lit ? Palette.water : Palette.lens).frame(width: s * 0.24)
                        .shadow(color: lit ? Palette.water : .clear, radius: s * 0.12)
                }
            }
            .frame(width: box.size.width, height: box.size.height)
        }
    }
}

/// The self-check: a dial whose red mark is where speech is (once as fast, a third of the way round), and its hand
/// how far ahead of speech the device reads, of three times.
struct DialThing: View {
    /// 0...1: of three times as fast as speech.
    var amount: Double
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            let c = CGPoint(x: box.size.width / 2, y: box.size.height / 2)
            let mark = Angle.degrees(-210 + 240.0 / 3).radians
            let hand = Angle.degrees(-210 + 240 * min(max(amount, 0), 1)).radians
            ZStack {
                Circle().fill(Palette.dial).overlay(Circle().stroke(Palette.dialEdge, lineWidth: scheme == .dark ? 1.3 : 1)).frame(width: s * 0.92)
                Circle().fill(scheme == .dark ? Palette.key : Palette.inkRed).frame(width: s * 0.1)
                    .shadow(color: scheme == .dark ? Palette.key : .clear, radius: s * 0.08)
                    .position(x: c.x + cos(mark) * s * 0.33, y: c.y + sin(mark) * s * 0.33)
                Path { path in
                    path.move(to: c)
                    path.addLine(to: CGPoint(x: c.x + cos(hand) * s * 0.32, y: c.y + sin(hand) * s * 0.32))
                }
                .stroke(Palette.dialHand, style: StrokeStyle(lineWidth: s * 0.06, lineCap: .round))
                .animation(.spring(duration: 0.8, bounce: 0.3), value: amount)
            }
        }
    }
}

/// A language: a pale card behind, a white one in front with the language's letter on it, as the Android app draws
/// its translation model (two panes).
struct LetterThing: View {
    var letter: String
    @Environment(\.colorScheme) private var scheme

    static let letters = ["ja": "あ", "en": "A", "zh": "中", "yue": "粤", "ko": "한", "es": "ñ", "fr": "é", "de": "ß", "it": "i", "pt": "ã", "hi": "अ"]

    var body: some View {
        ZStack(alignment: .topLeading) {
            if scheme == .dark {
                RoundedRectangle(cornerRadius: 9).fill(Palette.dial).overlay(RoundedRectangle(cornerRadius: 9).stroke(Palette.dialEdge, lineWidth: 1.3)).frame(width: 28, height: 28)
                RoundedRectangle(cornerRadius: 9)
                    .fill(Palette.key.opacity(0.22))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(Palette.key.opacity(0.7), lineWidth: 1.3))
                    .frame(width: 30, height: 30)
                    .overlay(Text(letter).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.ink))
                    .offset(x: 11, y: 11)
            } else {
            RoundedRectangle(cornerRadius: 9).fill(Palette.mint).frame(width: 28, height: 28)
            RoundedRectangle(cornerRadius: 9)
                .fill(Palette.tileFront)
                .shadow(color: Color(red: 0.59, green: 0.39, blue: 0.16).opacity(0.18), radius: 2.5, y: 1.5)
                .frame(width: 30, height: 30)
                .overlay(Text(letter).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.ink))
                .offset(x: 11, y: 11)
            }
        }
        .frame(width: 44, height: 44, alignment: .topLeading)
    }
}

/// The water at the bottom of the hearing widget: still while the device waits, a slow swell while it hears.
struct Water: View {
    var moving: Bool
    /// How high the water stands, of the widget.
    var level: Double = 0.16

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !moving)) { time in
            Canvas { context, size in
                let t = moving ? time.date.timeIntervalSinceReferenceDate : 0
                let y = size.height * (1 - level)
                context.fill(surface(size, y: y - 4, swell: moving ? 6 : 1.5, t: t * 0.9, seed: 1.7), with: .color(Palette.waterDeep))
                context.fill(surface(size, y: y, swell: moving ? 5 : 1, t: t * 1.3, seed: 0), with: .color(Palette.water))
            }
        }
        .allowsHitTesting(false)
    }

    nonisolated private func surface(_ size: CGSize, y: CGFloat, swell: CGFloat, t: Double, seed: Double) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: size.height))
        let steps = 48
        for i in 0...steps {
            let x = size.width * CGFloat(i) / CGFloat(steps)
            let k = Double(i) / Double(steps)
            let dy = sin(k * 2 * .pi * 1.3 + t + seed) * swell + sin(k * 2 * .pi * 0.6 - t * 0.7 + seed) * swell * 0.6
            path.addLine(to: CGPoint(x: x, y: y + dy))
        }
        path.addLine(to: CGPoint(x: size.width, y: size.height))
        path.closeSubpath()
        return path
    }
}

/// The dotted line in the hearing widget, which runs while the device waits for sound.
struct Dotted: View {
    var body: some View {
        Line()
            .stroke(Palette.waterSub.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [5, 6]))
            .frame(height: 1.5)
    }

    private nonisolated struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}

/// The settings' object: three faders on a small desk, the middle knob in the key's colour (`settingsIcon` in
/// Look.kt). Drawn alike by day and by night, in the objects' own faces.
struct FadersThing: View {
    var body: some View {
        Canvas { context, size in
            let s = min(size.width, size.height)
            let desk = CGRect(x: s * 0.06, y: s * 0.1, width: s * 0.88, height: s * 0.8)
            context.fill(Path(roundedRect: desk, cornerRadius: s * 0.18), with: .color(Palette.dial))
            context.stroke(Path(roundedRect: desk, cornerRadius: s * 0.18), with: .color(Palette.dialEdge), lineWidth: 1.2)
            for (i, at) in [0.38, 0.64, 0.46].enumerated() {
                let x = s * (0.28 + 0.22 * Double(i))
                var groove = Path()
                groove.move(to: CGPoint(x: x, y: s * 0.24))
                groove.addLine(to: CGPoint(x: x, y: s * 0.76))
                context.stroke(groove, with: .color(Palette.dialEdge), style: StrokeStyle(lineWidth: s * 0.05, lineCap: .round))
                let knob = CGRect(x: x - s * 0.08, y: s * at - s * 0.045, width: s * 0.16, height: s * 0.09)
                context.fill(Path(roundedRect: knob, cornerRadius: s * 0.03), with: .color(i == 1 ? Palette.key : Palette.dialHand))
            }
        }
    }
}

/// Translation: two panes, a pale apricot one behind and a white one in front (`PANES` in Look.kt).
struct PanesThing: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            ZStack(alignment: .topLeading) {
                if scheme == .dark {
                    RoundedRectangle(cornerRadius: s * 0.18).fill(Palette.dial).overlay(RoundedRectangle(cornerRadius: s * 0.18).stroke(Palette.dialEdge, lineWidth: 1.3))
                        .frame(width: s * 0.6, height: s * 0.6).offset(x: s * 0.04, y: s * 0.04)
                    RoundedRectangle(cornerRadius: s * 0.18).fill(Palette.key.opacity(0.25)).overlay(RoundedRectangle(cornerRadius: s * 0.18).stroke(Palette.key.opacity(0.7), lineWidth: 1.3))
                        .frame(width: s * 0.62, height: s * 0.62).offset(x: s * 0.32, y: s * 0.32)
                } else {
                    RoundedRectangle(cornerRadius: s * 0.18).fill(Color(red: 0.94, green: 0.67, blue: 0.35).opacity(0.55))
                        .frame(width: s * 0.62, height: s * 0.62).offset(x: s * 0.02, y: s * 0.02)
                    RoundedRectangle(cornerRadius: s * 0.18).fill(.white.opacity(0.94))
                        .shadow(color: Color(red: 0.59, green: 0.39, blue: 0.16).opacity(0.2), radius: 3, y: 2)
                        .frame(width: s * 0.62, height: s * 0.62).offset(x: s * 0.32, y: s * 0.32)
                }
            }
            .frame(width: box.size.width, height: box.size.height, alignment: .topLeading)
        }
    }
}

/// Grammar feedback: a sheet of ruled paper with a red dot at its corner (`NOTE` in Look.kt).
struct NoteThing: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Canvas { context, size in
            let s = min(size.width, size.height)
            let dark = scheme == .dark
            let sheet = CGRect(x: s * 0.14, y: s * 0.08, width: s * 0.68, height: s * 0.86)
            let shape = Path(roundedRect: sheet, cornerRadius: s * 0.12)
            context.fill(shape, with: .color(dark ? Palette.dial : .white))
            if dark { context.stroke(shape, with: .color(Palette.dialEdge), lineWidth: 1.3) }
            var y = sheet.minY + s * 0.28
            while y < sheet.maxY - s * 0.1 {
                var rule = Path()
                rule.move(to: CGPoint(x: sheet.minX + s * 0.11, y: y)); rule.addLine(to: CGPoint(x: sheet.maxX - s * 0.11, y: y))
                context.stroke(rule, with: .color(dark ? Palette.dialEdge : Color(red: 0.94, green: 0.91, blue: 0.89)), lineWidth: 1)
                y += s * 0.18
            }
            let dot = CGRect(x: sheet.maxX - s * 0.02 - s * 0.1, y: sheet.minY + s * 0.02 - s * 0.1, width: s * 0.2, height: s * 0.2)
            context.fill(Path(ellipseIn: dot), with: .color(dark ? Palette.key : Palette.inkRed))
        }
        .shadow(color: scheme == .dark ? .clear : Color(red: 0.47, green: 0.31, blue: 0.27).opacity(0.18), radius: 3, y: 2)
    }
}
