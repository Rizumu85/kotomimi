import SwiftUI
import UIKit

/// The look, as the Android app has it (android/app/src/main/res/values*/colors.xml and Look.kt): the OriginOS 1.0
/// desktop the owner pointed to, in the apricot-and-mint family — a pale wall with two soft fields coloured by what
/// the device is doing, warm white widgets, small flat objects that stand for what each widget does. At night,
/// neutral blacks lit by the colour of the work, after Folia. Where iOS has a control of its own (the switch, the
/// sheets, the round keys) its Liquid Glass one is used.
enum Palette {
    static let wall = Color(day: 0xF2EFE8, night: 0x070708)
    static let mintPale = Color(day: 0xDCEAE2, night: 0x4E9A7E)
    static let mint = Color(day: 0xCFE7DA, night: 0x3FB088)
    static let blue = Color(day: 0xDCE6EE, night: 0x4F7A94)
    static let tile = Color(day: 0xFFFDF8, night: 0x26262A)
    static let card = Color(day: 0xF5F2EB, night: 0x303035)
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
}

extension Color {
    init(day: UInt32, night: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? night : day
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
}

/// The wallpaper: the wall, a field of the work's colour falling from the top left, a pale blue one rising at the
/// bottom right, and a fine grid of dots fading in towards the bottom. Drawn once for a size: nothing moves on it,
/// so the device spends nothing on it while it is lent.
struct Wall: View {
    var working: Bool

    var body: some View {
        GeometryReader { box in
            let w = box.size.width, h = box.size.height
            ZStack {
                Palette.wall
                Ellipse()
                    .fill(working ? Palette.mint : Palette.mintPale)
                    .frame(width: max(w, h) * 1.15, height: max(w, h) * 0.95)
                    .position(x: w * 0.08, y: -h * 0.02)
                    .blur(radius: 2)
                Ellipse()
                    .fill(Palette.blue)
                    .frame(width: max(w, h) * 1.05, height: max(w, h) * 0.9)
                    .position(x: w * 0.98, y: h * 1.02)
                    .blur(radius: 2)
                Canvas { context, size in
                    let every: CGFloat = 30
                    var y = size.height * 0.55
                    var row = 0
                    while y < size.height {
                        let k = (y - size.height * 0.55) / (size.height * 0.45)
                        var x: CGFloat = row % 2 == 0 ? 14 : 14 + every / 2
                        while x < size.width {
                            let r: CGFloat = 1.5
                            context.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)), with: .color(Palette.dot.opacity(0.08 + 0.22 * k)))
                            x += every
                        }
                        y += every
                        row += 1
                    }
                }
            }
            .animation(.easeInOut(duration: 1.2), value: working)
        }
        .ignoresSafeArea()
    }
}

/// A widget: warm white, its corners round, a little glass to it so the wall shows faintly through.
struct Tile<Content: View>: View {
    var padding: CGFloat = 22
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Palette.tile.opacity(0.82), in: .rect(cornerRadius: 32))
            .glassEffect(.regular.tint(Palette.tile.opacity(0.25)), in: .rect(cornerRadius: 32))
    }
}

// ── The objects ─────────────────────────────────────────────────────────────────────────────────────────────

/// Hearing: a glass of water, dark with the water's mint in its lower part.
struct WaterThing: View {
    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: s * 0.2).fill(Palette.waterTile)
                Palette.water.frame(height: s * 0.92 * 0.42)
            }
            .clipShape(.rect(cornerRadius: s * 0.2))
            .frame(width: s * 0.74, height: s * 0.92)
            .frame(width: box.size.width, height: box.size.height)
        }
    }
}

/// The devices: a camera's lens, its centre lit while a computer is at work with the device.
struct LensThing: View {
    var lit: Bool

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            ZStack {
                Circle().fill(Palette.lens).frame(width: s * 0.92).shadow(color: .black.opacity(0.24), radius: 3, y: 2)
                Circle().fill(Palette.lensInner).frame(width: s * 0.58)
                Circle().fill(lit ? Palette.water : Palette.lens).frame(width: s * 0.24)
                    .shadow(color: lit ? Palette.water : .clear, radius: s * 0.12)
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

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            let c = CGPoint(x: box.size.width / 2, y: box.size.height / 2)
            let mark = Angle.degrees(-210 + 240.0 / 3).radians
            let hand = Angle.degrees(-210 + 240 * min(max(amount, 0), 1)).radians
            ZStack {
                Circle().fill(Palette.dial).overlay(Circle().stroke(Palette.dialEdge, lineWidth: 1)).frame(width: s * 0.92)
                Circle().fill(Palette.inkRed).frame(width: s * 0.11)
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

/// Languages: a stack of cards, the language letters on the top one.
struct CardsThing: View {
    var letters: String

    var body: some View {
        GeometryReader { box in
            let s = min(box.size.width, box.size.height)
            ZStack {
                RoundedRectangle(cornerRadius: s * 0.16).fill(Palette.mint).frame(width: s * 0.62, height: s * 0.62).offset(x: -s * 0.15, y: -s * 0.15)
                RoundedRectangle(cornerRadius: s * 0.16).fill(.white)
                    .shadow(color: Color(red: 0.59, green: 0.39, blue: 0.16).opacity(0.2), radius: 3, y: 2)
                    .frame(width: s * 0.62, height: s * 0.62).offset(x: s * 0.15, y: s * 0.15)
                Text(letters).font(.system(size: s * 0.24, weight: .semibold, design: .rounded)).foregroundStyle(Color(day: 0x3A3026, night: 0x1F2A30))
                    .offset(x: s * 0.15, y: s * 0.15)
            }
            .frame(width: box.size.width, height: box.size.height)
        }
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

    private func surface(_ size: CGSize, y: CGFloat, swell: CGFloat, t: Double, seed: Double) -> Path {
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

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            return path
        }
    }
}
