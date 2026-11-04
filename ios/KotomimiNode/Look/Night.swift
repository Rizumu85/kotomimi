import CoreGraphics
import SwiftUI

/// The night's wallpaper, as the Android app has it (`drawFume` and `drawShapes` in Look.kt): not painted fields but a
/// flowing field of soft folds, the smoke behind Folia's lyric scenes, its light the two colours of what the device
/// is doing, greyed and running into each other; low while nothing is lent, lifting once it is. Over it, thin pale
/// linework — hairlines with diamond ends, corner brackets, crosses, small flowers, arches, triangles — each drifting,
/// fading in, lingering and fading out, then coming back elsewhere as another.
///
/// Worked out small and drawn large, so it is soft; a dozen times a second, which is all slow smoke needs.
struct NightWall: View {
    /// Whether the device is lent: the smoke lifts.
    var lent: Bool
    /// Whether a computer is at work with it now: the mint of hearing in place of the sage.
    var working: Bool

    @State private var lift: Double = NightWall.idleBright
    @State private var drift = Drift()

    static let idleBright = 0.22
    private static let night = RGB(0x070708)
    private static let sage = RGB(0x4E9A7E)
    private static let mint = RGB(0x3FB088)
    private static let mist = RGB(0x4F7A94)

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 12)) { time in
            let t = time.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000)
            Canvas { context, size in
                let image = NightWall.fume(size, t: t, bright: lift, a: working ? NightWall.mint : NightWall.sage, b: NightWall.mist)
                context.draw(Image(decorative: image, scale: 1).interpolation(.high), in: CGRect(origin: .zero, size: size))
                drift.draw(context, size, t: t)
            }
        }
        .background(Color(red: 7 / 255, green: 7 / 255, blue: 8 / 255))
        .ignoresSafeArea()
        .onAppear { lift = lent ? 1 : NightWall.idleBright }
        .onChange(of: lent) { _, now in
            // At the pace the colours turn, never at once.
            withAnimation(.easeInOut(duration: 1.6)) { lift = now ? 1 : NightWall.idleBright }
        }
    }

    nonisolated struct RGB: Sendable {
        var r, g, b: Double
        init(_ hex: UInt32) { r = Double((hex >> 16) & 0xFF); g = Double((hex >> 8) & 0xFF); b = Double(hex & 0xFF) }
        init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
        func mixed(_ o: RGB, _ t: Double) -> RGB { RGB(r: r + (o.r - r) * t, g: g + (o.g - g) * t, b: b + (o.b - b) * t) }
        /// Greyed toward its own lightness, as smoke takes a colour.
        var muted: RGB {
            let grey = r * 0.3 + g * 0.59 + b * 0.11
            return mixed(RGB(r: grey, g: grey, b: grey), 0.42).mixed(RGB(r: 0, g: 0, b: 0), 0.18)
        }
    }

    nonisolated private static func smooth(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let k = min(1, max(0, (x - a) / (b - a)))
        return k * k * (3 - 2 * k)
    }

    /// The folds, 40 cells across.
    nonisolated static func fume(_ size: CGSize, t: Double, bright: Double, a: RGB, b: RGB) -> CGImage {
        let cols = 40
        let w = max(Double(size.width), 1), h = max(Double(size.height), 1)
        let rows = min(120, max(24, Int(Double(cols) * h / w)))
        let unit = min(w, h)
        let tt = t * 0.9
        let ma = a.muted, mb = b.muted
        var pixels = [UInt8](repeating: 255, count: cols * rows * 4)
        for j in 0..<rows {
            let y = Double(j) / Double(rows) * h / unit * 2.2
            for i in 0..<cols {
                let x = Double(i) / Double(cols) * w / unit * 2.2
                let warp = sin(y * 1.3 + tt * 0.35) * 0.9 + sin(x * 0.8 - tt * 0.22) * 0.6
                let fold = sin((x * 1.5 + y * 0.9) * 1.3 + warp + tt * 0.28)
                let fold2 = sin(x * 0.7 - y * 1.6 + tt * 0.17 + warp * 0.5)
                var light = smooth(-0.3, 1, fold) * 0.6 + smooth(0, 1, fold2) * 0.3
                // Darker toward the foot, where the widgets stand thickest, and a little at the sides.
                let v = Double(j) / Double(rows)
                light *= 0.55 + 0.45 * (1 - v * 0.7) * (1 - 0.35 * abs(Double(i) / Double(cols) - 0.5) * 2)
                let hue = 0.5 + 0.5 * sin(x * 0.6 + y * 0.45 + tt * 0.1)
                // Never quite black: a haze of the colour everywhere, and the folds lighter in it.
                let c = night.mixed(ma.mixed(mb, hue), min(1, max(0, (0.16 + light * 0.78) * bright)))
                let p = (j * cols + i) * 4
                pixels[p] = UInt8(c.r); pixels[p + 1] = UInt8(c.g); pixels[p + 2] = UInt8(c.b)
            }
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        return CGImage(width: cols, height: rows, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: cols * 4,
                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
    }
}

/// The night's linework. Each shape's whole life follows from its seed and the time, so nothing is kept from frame
/// to frame: a shape drifts along its heading, rises, lingers and fades, and its next life is another shape elsewhere.
nonisolated struct Drift: Sendable {
    private struct Seed: Sendable { let depth, speed, heading, phase, life: Double; let index: Int }
    private let seeds: [Seed] = (0..<18).map { i in
        func r(_ salt: Int) -> Double { Drift.hash(i, salt) }
        return Seed(depth: 0.4 + r(1) * 0.6, speed: 1.5 + r(2) * 3.5, heading: r(3) * 2 * .pi, phase: r(4), life: 12 + r(5) * 12, index: i)
    }

    static func hash(_ i: Int, _ salt: Int) -> Double {
        var n = UInt32(truncatingIfNeeded: i &* 374_761_393 &+ salt &* 668_265_263 &+ 1_013_904_223)
        n = (n ^ (n >> 13)) &* 1_274_126_177
        return Double((n ^ (n >> 16)) & 0xFFFFFF) / 16_777_216
    }

    func draw(_ context: GraphicsContext, _ size: CGSize, t: Double) {
        // About one to every 130 points square, as there.
        let count = min(seeds.count, max(8, Int(size.width * size.height / (130 * 130))))
        for seed in seeds.prefix(count) {
            let lived = t / seed.life + seed.phase
            let life = Int(lived.rounded(.down))
            let k = lived - Double(life)
            let x0 = Drift.hash(seed.index * 31 + life, 6) * size.width
            let y0 = Drift.hash(seed.index * 31 + life, 7) * size.height
            let kind = Int(Drift.hash(seed.index * 31 + life, 8) * 7)
            let along = k * seed.life * seed.speed * seed.depth
            let x = x0 + cos(seed.heading) * along
            let y = y0 + sin(seed.heading) * along
            let size1 = Drift.hash(seed.index * 31 + life, 9)
            let span: Double = switch kind { case 0: 110 + size1 * 150; case 4: 46 + size1 * 40; case 1: 26 + size1 * 20; default: 10 + size1 * 8 }
            let envelope = smooth(0, 0.2, k) * (1 - smooth(0.75, 1, k))
            let alpha = (0.12 + 0.22 * seed.depth) * envelope
            guard alpha > 0.01 else { continue }
            let ink = GraphicsContext.Shading.color(Color(red: 0.855, green: 0.855, blue: 0.886).opacity(alpha))
            let stroke = StrokeStyle(lineWidth: 1, lineCap: .round)
            let r = span / 2
            var path = Path()
            switch kind {
            case 0:
                path.move(to: CGPoint(x: x - r, y: y)); path.addLine(to: CGPoint(x: x + r, y: y))
                context.stroke(path, with: ink, style: stroke)
                for e in [x - r, x + r] { context.fill(diamond(e, y, 3), with: ink) }
                continue
            case 1:
                path.move(to: CGPoint(x: x + r, y: y)); path.addLine(to: CGPoint(x: x, y: y)); path.addLine(to: CGPoint(x: x, y: y + r))
            case 2:
                path.move(to: CGPoint(x: x - r, y: y)); path.addLine(to: CGPoint(x: x + r, y: y))
                path.move(to: CGPoint(x: x, y: y - r)); path.addLine(to: CGPoint(x: x, y: y + r))
            case 3:
                for (ox, oy) in [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)] {
                    context.fill(Path(ellipseIn: CGRect(x: x + ox * r * 0.6 - 1.6, y: y + oy * r * 0.6 - 1.6, width: 3.2, height: 3.2)), with: ink)
                }
                continue
            case 4:
                path.move(to: CGPoint(x: x - r * 0.6, y: y + r))
                path.addLine(to: CGPoint(x: x - r * 0.6, y: y - r * 0.4))
                path.addArc(center: CGPoint(x: x, y: y - r * 0.4), radius: r * 0.6, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
                path.addLine(to: CGPoint(x: x + r * 0.6, y: y + r))
            case 5:
                path.move(to: CGPoint(x: x - r, y: y - r)); path.addLine(to: CGPoint(x: x + r, y: y + r))
                path.move(to: CGPoint(x: x - r, y: y + r)); path.addLine(to: CGPoint(x: x + r, y: y - r))
            default:
                path.move(to: CGPoint(x: x, y: y - r))
                path.addLine(to: CGPoint(x: x + r * 0.87, y: y + r * 0.5))
                path.addLine(to: CGPoint(x: x - r * 0.87, y: y + r * 0.5))
                path.closeSubpath()
            }
            context.stroke(path, with: ink, style: stroke)
        }
    }

    private func diamond(_ x: Double, _ y: Double, _ r: Double) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: x, y: y - r)); path.addLine(to: CGPoint(x: x + r, y: y))
        path.addLine(to: CGPoint(x: x, y: y + r)); path.addLine(to: CGPoint(x: x - r, y: y)); path.closeSubpath()
        return path
    }

    private func smooth(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let k = min(1, max(0, (x - a) / (b - a)))
        return k * k * (3 - 2 * k)
    }
}
