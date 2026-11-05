import CoreMotion
import SwiftUI
import UIKit

/// What the device is doing, for the wallpaper's colours (`Mood` in the Android app's Look.kt).
nonisolated enum Mood: Sendable, Equatable { case idle, hear, translate, coach }

/// Where the page has something in front — widgets and writing — in the wall's space: the dots keep clear of it.
nonisolated struct CoverKey: PreferenceKey {
    static let defaultValue: [CGRect] = []
    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) { value.append(contentsOf: nextValue()) }
}

extension View {
    /// This stands in front of the wallpaper: its dots keep clear of it.
    func covers() -> some View {
        background(GeometryReader { box in Color.clear.preference(key: CoverKey.self, value: [box.frame(in: .named(Living.space))]) })
    }
}

/// The wallpaper as the Android app's (`Wall` in Look.kt), alive: large soft fields of colour — by night a smoke of
/// soft folds — coloured by what the device is doing and always slowly moving, slower while nothing is lent; and in
/// front of them a layer of fine dots held as if in an acrylic block of oil with glitter in it (流麻). It answers
/// what happens: a stretch heard sets the fields' edges trembling, a sentence translated sends a light sweeping
/// across, a correction spreads like a drop of red ink. The dots gather in drifts that slowly move, keep clear of
/// what stands in front, settle toward the way the device is held and sway as it is turned; a few catch the light,
/// as glitter does. A finger sends a wave out through them.
struct Living: View {
    static let space = "wall"

    var mood: Mood
    var lent: Bool
    var working: Bool
    /// The work done, by kind: each new one is answered.
    var heard: Int
    var translated: Int
    var coached: Int
    var covered: [CGRect]

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var motion = WallMotion()
    /// Whether something moves more than the drift — a wave, a sweep, the device turned, the colours changing.
    @State private var lively = false

    var body: some View {
        // Drawn every frame while something moves, and at a slow drift's pace otherwise, as the Android app does: each
        // frame composes the whole screen again, the translucent widgets over the wall.
        TimelineView(.animation(minimumInterval: still ? 1 : lively ? 1 / 60 : 1 / 15)) { time in
            Canvas { context, size in
                motion.draw(&context, size, now: time.date.timeIntervalSinceReferenceDate, dark: scheme == .dark, covered: covered, still: still)
            }
        }
        .ignoresSafeArea()
        .contentShape(.rect)
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named(Living.space))
            .onChanged { touch in
                motion.touch(touch.location, first: touch.translation == .zero)
                lively = true
            }
            .onEnded { _ in motion.lift() })
        .onAppear {
            motion.set(mood: mood, lent: lent, working: working, at: Date.timeIntervalSinceReferenceDate)
            motion.start()
        }
        // Looked at twice a second: how fast to draw.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                let now = !motion.calm
                if now != lively { lively = now }
            }
        }
        .onDisappear { motion.stop() }
        .onChange(of: mood) { _, now in motion.set(mood: now, lent: lent, working: working, at: Date.timeIntervalSinceReferenceDate) }
        .onChange(of: lent) { _, now in motion.set(mood: mood, lent: now, working: working, at: Date.timeIntervalSinceReferenceDate) }
        .onChange(of: working) { _, now in motion.set(mood: mood, lent: lent, working: now, at: Date.timeIntervalSinceReferenceDate) }
        .onChange(of: heard) { motion.pulse(.hear); lively = true }
        .onChange(of: translated) { motion.pulse(.translate); lively = true }
        .onChange(of: coached) { motion.pulse(.coach); lively = true }
    }
}

/// The wallpaper's state from frame to frame. Touched only on the main thread: by the views and by the drawing.
nonisolated final class WallMotion: @unchecked Sendable {
    // ── Time and colour ──
    private var last: Double = 0
    private var t: Double = 0
    private var pace: Double = 0.3
    private var mood: Mood = .idle
    private var from: Mood = .idle
    private var turned: Double = 1
    private var brightFrom = 0.22, brightTo = 0.22

    // ── What happened ──
    private var tremble: Double = 0
    private var sweep: Double = -1
    private struct Drop { let x, y: Double; var age: Double = 0 }
    private var drops: [Drop] = []
    private struct Wave { let x, y, strength: Double; var age: Double = 0 }
    private var waves: [Wave] = []
    private var flash: Double = 0
    private var size: CGSize = .zero
    private var held = false
    private var marked = CGPoint.zero

    // ── Which way is down, on the screen: as the sensor says it, followed quickly, and slowly ──
    private let sensors = CMMotionManager()
    private var down = CGPoint(x: 0, y: 0.7)
    private var quick = CGPoint(x: 0, y: 0.7)
    private var slow = CGPoint(x: 0, y: 0.7)
    /// How much the device has just been moved: more of the glitter catches the light.
    private var stir: Double = 0

    static let idleBright = 0.22

    func start() {
        guard sensors.isDeviceMotionAvailable, !sensors.isDeviceMotionActive else { return }
        sensors.deviceMotionUpdateInterval = 1 / 30
        sensors.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self, let g = data?.gravity else { return }
            // The sensor speaks in the device's own frame; the screen may be turned. Down on the screen is with it.
            let turn = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.effectiveGeometry.interfaceOrientation ?? .portrait
            let (sx, sy): (Double, Double) = switch turn {
            case .landscapeLeft: (g.y, g.x)
            case .landscapeRight: (-g.y, -g.x)
            case .portraitUpsideDown: (-g.x, g.y)
            default: (g.x, -g.y)
            }
            self.down = CGPoint(x: min(1, max(-1, sx)), y: min(1, max(-1, sy)))
        }
    }

    func stop() { sensors.stopDeviceMotionUpdates() }

    func set(mood next: Mood, lent: Bool, working: Bool, at now: Double) {
        pace = working ? 1 : lent ? 0.6 : 0.3
        let want: Mood = lent ? next : .idle
        guard want != mood else { return }
        brightFrom += (brightTo - brightFrom) * ease(turned)
        brightTo = want == .idle ? WallMotion.idleBright : 1
        from = mood
        mood = want
        turned = 0
    }

    /// Something was done: the wallpaper answers in the way of that work, and a wave runs out through the dots.
    func pulse(_ work: Mood) {
        let x = size.width * 0.5, y = size.height * 0.55
        switch work {
        case .hear: tremble = 1
        case .translate: sweep = 0
        case .coach: drops.append(Drop(x: x, y: y))
        case .idle: break
        }
        waves.append(Wave(x: x, y: y, strength: 0.8))
        flash = 1
    }

    func touch(_ at: CGPoint, first: Bool) {
        if first {
            held = true
            marked = at
            stir = min(1, stir + 0.2)
            waves.append(Wave(x: at.x, y: at.y, strength: 1))
        } else if held, hypot(at.x - marked.x, at.y - marked.y) > 56 {
            // The finger moves: smaller waves follow it as it goes.
            marked = at
            waves.append(Wave(x: at.x, y: at.y, strength: 0.4))
            if waves.count > 12 { waves.removeFirst(waves.count - 12) }
        }
    }

    func lift() { held = false }

    private func ease(_ k: Double) -> Double { k * k * (3 - 2 * k) }

    /// Nothing moves but the drift.
    var calm: Bool {
        !held && waves.isEmpty && drops.isEmpty && stir < 0.08 && sweep < 0 && tremble <= 0 && turned >= 1 && flash <= 0
            && abs(quick.x - slow.x) + abs(quick.y - slow.y) < 0.02
    }

    private func step(_ dt: Double) {
        t += dt * pace
        if turned < 1 { turned = min(1, turned + dt / 1.5) }
        tremble = max(0, tremble - dt * 1.2)
        if sweep >= 0 { sweep = sweep > 1.3 ? -1 : sweep + dt / 1.1 }
        for i in drops.indices { drops[i].age += dt }
        drops.removeAll { $0.age > 1.6 }
        let was = quick
        let fast = min(1, dt / 0.12), lag = min(1, dt / 1.4)
        quick.x += (down.x - quick.x) * fast; quick.y += (down.y - quick.y) * fast
        slow.x += (quick.x - slow.x) * lag; slow.y += (quick.y - slow.y) * lag
        stir = min(1, max(0, stir + hypot(quick.x - was.x, quick.y - was.y) * 1.6 - dt * 0.55))
        for i in waves.indices { waves[i].age += dt }
        waves.removeAll { $0.age > WallMotion.waveLasts }
        flash = max(0, flash - dt * 0.9)
    }

    // ── Colours ──

    private typealias RGB = NightWall.RGB

    /// The wall and its two fields, for a mood: by day the Android app's field colours, by night its glows.
    private static func colours(_ mood: Mood, dark: Bool) -> (RGB, RGB, RGB) {
        if dark {
            switch mood {
            case .idle: return (RGB(0x070708), RGB(0x4E9A7E), RGB(0x4F7A94))
            case .hear: return (RGB(0x070708), RGB(0x3FB088), RGB(0x4F7A94))
            case .translate: return (RGB(0x070708), RGB(0xD9853F), RGB(0x4F7A94))
            case .coach: return (RGB(0x070708), RGB(0xD9644E), RGB(0x8A7BA8))
            }
        }
        switch mood {
        case .idle: return (RGB(0xF2EFE8), RGB(0xDCEAE2), RGB(0xDCE6EE))
        case .hear: return (RGB(0xF2EFE8), RGB(0xCFE7DA), RGB(0xDCE6EE))
        case .translate: return (RGB(0xF2EFE8), RGB(0xF8DDB4), RGB(0xDCE6EE))
        case .coach: return (RGB(0xF2EFE8), RGB(0xF3D5CC), RGB(0xE6E0F0))
        }
    }

    private static func color(_ c: RGB, _ alpha: Double = 1) -> Color { Color(red: c.r / 255, green: c.g / 255, blue: c.b / 255).opacity(alpha) }

    // ── Drawing ──

    private let drift = Drift()

    func draw(_ context: inout GraphicsContext, _ size: CGSize, now: Double, dark: Bool, covered: [CGRect], still: Bool) {
        let dt = last == 0 ? 0 : min(0.05, now - last)
        last = now
        self.size = size
        step(still ? 0 : dt)
        let w = size.width, h = size.height
        let a = WallMotion.colours(from, dark: dark), b = WallMotion.colours(mood, dark: dark)
        let k = ease(turned)
        let c0 = a.0.mixed(b.0, k), c1 = a.1.mixed(b.1, k), c2 = a.2.mixed(b.2, k)
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(WallMotion.color(c0)))
        // The fields lie furthest back: they sway a little as the device turns.
        let sway = CGPoint(x: (quick.x - slow.x) * 4, y: (quick.y - slow.y) * 4)
        if dark {
            let bright = brightFrom + (brightTo - brightFrom) * k
            let image = NightWall.fume(size, t: t, bright: bright, a: c1, b: c2)
            context.draw(Image(decorative: image, scale: 1).interpolation(.high), in: CGRect(origin: .zero, size: size))
        } else {
            let u = min(w, h)
            field(&context, x: sway.x + w * 0.08 + sin(t * 0.7) * u * 0.05, y: h * 0.06 + sway.y + cos(t * 0.5) * u * 0.04, r: u * 0.85, color: c1, seed: 0)
            field(&context, x: sway.x + w * 1.0 + cos(t * 0.6) * u * 0.05, y: h * 0.7 + sway.y * 1.5 + sin(t * 0.45) * u * 0.05, r: u * 0.8, color: c2, seed: 2.1)
        }
        // A sentence translated: a band of light sweeps across, left to right.
        if sweep >= 0 && sweep <= 1.3 {
            let x = -w * 0.3 + sweep * w * 1.6
            var band = Path()
            band.move(to: CGPoint(x: x, y: 0)); band.addLine(to: CGPoint(x: x + w * 0.22, y: 0))
            band.addLine(to: CGPoint(x: x + w * 0.02, y: h)); band.addLine(to: CGPoint(x: x - w * 0.2, y: h)); band.closeSubpath()
            context.fill(band, with: .color(.white.opacity(max(0, 0.27 * sin(min(1, sweep) * .pi)))))
        }
        // A correction's red ink, spreading out in a ring.
        for d in drops {
            let k = d.age / 1.6
            let r = 10 + k * w * 0.4
            context.fill(Path(ellipseIn: CGRect(x: d.x - r, y: d.y - r, width: r * 2, height: r * 2)),
                         with: .color(Color(red: 0xE3 / 255, green: 0x5D / 255, blue: 0x45 / 255).opacity(max(0, 1 - k) * 0.12)))
        }
        if dark { drift.draw(context, size, t: t, flash: flash) }
        dots(&context, size, dark: dark, covered: covered)
    }

    /// A field: a round shape whose edge breathes, and trembles when something is heard.
    private func field(_ context: inout GraphicsContext, x cx: Double, y cy: Double, r: Double, color: RGB, seed: Double) {
        var path = Path()
        let n = 48
        for i in 0...n {
            let a = Double(i) * 2 * .pi / Double(n)
            let wobble = sin(a * 3 + t * 1.3 + seed) * 0.035 + sin(a * 5 - t + seed * 2) * 0.02 + tremble * sin(a * 11 + t * 9) * 0.025
            let rr = r * (1 + wobble)
            let p = CGPoint(x: cx + cos(a) * rr, y: cy + sin(a) * rr * 1.06)
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        context.fill(path, with: .color(WallMotion.color(color)))
    }

    // ── The dots ──

    static let every: Double = 13
    static let levels = 12
    static let litLevels = 4
    static let sequins = 0.22
    static let waveLasts = 2.8
    private static let glints: [RGB] = [RGB(0xE86A52), RGB(0x3FAF8F), RGB(0x4D86D9), RGB(0xE9A23B)]
    private static let nightGlints: [RGB] = [RGB(0xFFFFFF), RGB(0xFFE7C9), RGB(0xD3E8FF), RGB(0xF2D6FF)]

    private static func hash(_ i: Int, _ j: Int, _ salt: Int) -> Double {
        var n = UInt32(truncatingIfNeeded: i &* 374_761_393 &+ j &* 668_265_263 &+ salt &* 2_147_483_647)
        n = (n ^ (n >> 13)) &* 1_274_126_177
        return Double((n ^ (n >> 16)) & 0xFFFFFF) / 16_777_216
    }

    private static func smooth(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let k = min(1, max(0, (x - a) / (b - a)))
        return k * k * (3 - 2 * k)
    }

    private var rooms: [[Double]] = [[], []]
    private var roomsFor: ([CGRect], CGSize)?

    /// How far a point is from the nearest thing in front: negative inside it.
    private static func distance(_ x: Double, _ y: Double, _ covered: [CGRect]) -> Double {
        var best = Double.greatestFiniteMagnitude
        for r in covered {
            let dx = max(r.minX - x, 0, x - r.maxX), dy = max(r.minY - y, 0, y - r.maxY)
            let d = dx == 0 && dy == 0 ? -min(x - r.minX, r.maxX - x, y - r.minY, r.maxY - y) : hypot(dx, dy)
            best = min(best, d)
        }
        return best
    }

    /// Two grids, one deeper in the block than the other and offset by half a step — the deeper one smaller, fainter
    /// and swaying less — each dot shown by how much drift is where it stands and how far it is from what stands in
    /// front, the edge of that room wandering with the flow.
    private func dots(_ context: inout GraphicsContext, _ size: CGSize, dark: Bool, covered: [CGRect]) {
        let w = size.width, h = size.height
        let every = WallMotion.every
        let scale = 150.0, feather = 52.0, clear = 4.0, reach = 1.6, wander = 36.0, grainy = 18.0
        let hidden = clear - wander / 2 - grainy / 2
        let waveWide = 46.0, waveSpeed = 230.0
        let light = quick.x * 0.8 + quick.y * 0.6 + t * 0.03
        let shine = 0.3 + stir * 0.7
        let ink = dark ? RGB(0xDADAE2) : RGB(0x283446)
        let glints = dark ? WallMotion.nightGlints : WallMotion.glints
        var plain = Array(repeating: Array(repeating: Path(), count: WallMotion.levels), count: 2)
        var lit = Array(repeating: Array(repeating: [CGPoint](), count: WallMotion.litLevels), count: glints.count)
        let columns = Int((w / every).rounded(.up)) + 2
        let rows = Int((h / every).rounded(.up)) + 2
        let across = columns + 1
        if roomsFor == nil || roomsFor!.0 != covered || roomsFor!.1 != size {
            roomsFor = (covered, size)
            for layer in 0...1 {
                let shift = layer == 0 ? every / 2 : 0
                var room = [Double](repeating: 1000, count: across * (rows + 1))
                if !covered.isEmpty {
                    for j in -1..<rows {
                        for i in -1..<columns {
                            room[(j + 1) * across + i + 1] = WallMotion.distance(Double(i) * every + every / 2 + shift, shift + Double(j) * every, covered)
                        }
                    }
                }
                rooms[layer] = room
            }
        }
        for layer in 0...1 {
            let gaps = rooms[layer]
            let deep = layer == 0
            let swayAmount = deep ? 3.0 : 8.0
            let sx = (quick.x - slow.x) * swayAmount, sy = (quick.y - slow.y) * swayAmount
            let aside = deep ? every / 2 : 0, back = deep ? every / 2 : 0
            let tt = t + (deep ? 7.3 : 0)
            let push = deep ? 1.8 : 3.2
            for j in -1..<rows {
                let ry = back + Double(j) * every
                let warpX = sin(ry / scale * 1.3 + tt * 0.37)
                for i in -1..<columns {
                    let rx = Double(i) * every + every / 2 + aside
                    let near = gaps[(j + 1) * across + i + 1]
                    if near < hidden { continue }
                    // The flow: slow folds of drift, moving.
                    let fx = rx / scale, fy = ry / scale
                    let flow = 0.5 + 0.28 * sin(fx * 1.1 + tt * 0.21 + sin(fy * 0.7 - tt * 0.13) * 1.4)
                        + 0.22 * sin(fy * 1.3 - tt * 0.17 + sin(fx * 0.9 + tt * 0.11) * 1.2)
                    var x = rx + warpX * reach + sx
                    var y = ry + (flow - 0.5) * 2 * reach + sy
                    let grain = WallMotion.hash(i, j, 5 + layer) - 0.5
                    // Toward down there is more of it; each dot has its own threshold, so a drift's edge is grains.
                    let settle = (slow.x * (rx / w - 0.5) + slow.y * (ry / h - 0.5)) * 0.5
                    let amount = WallMotion.smooth(0.46, 0.84, flow + settle + grain * 0.32)
                    var swell = 0.0
                    for wave in waves {
                        let dx = rx - wave.x, dy = ry - wave.y
                        let r = (dx * dx + dy * dy).squareRoot()
                        let u = (r - wave.age * waveSpeed) / waveWide
                        if u < -3 || u > 3 { continue }
                        let s = exp(-u * u) * cos(u * 1.5) * wave.strength * exp(-wave.age * 0.95)
                        if r > 1 { x += dx / r * s * push; y += dy / r * s * push }
                        swell += max(0, s) * 0.9
                    }
                    if amount + swell <= 0.02 { continue }
                    let room = WallMotion.smooth(clear, clear + feather, near + (flow - 0.5) * wander + grain * grainy)
                    let close = swell > 0 ? WallMotion.smooth(clear, clear + feather * 0.3, near + grain * grainy * 0.5) : 0
                    if room <= 0.01 && close <= 0.01 { continue }
                    let shown = min(1.2, max(0, amount * room + swell * close))
                    // A few are glitter: each catches the light at its own turn of the device, where the drift is.
                    if !deep && WallMotion.hash(i, j, 17) < WallMotion.sequins {
                        let turn = cos((WallMotion.hash(i, j, 3) * 3 + light) * 2 * .pi)
                        let caught = turn > 0.95 ? exp((turn - 1) * 80) * shine * amount : 0
                        let sparkle = min(1, max(0, caught * room))
                        if sparkle > 0.1 {
                            let hue = ((Int(WallMotion.hash(i, j, 13) * Double(glints.count) + light * 2) % glints.count) + glints.count) % glints.count
                            lit[hue][min(WallMotion.litLevels - 1, Int(sparkle * Double(WallMotion.litLevels)))].append(CGPoint(x: x, y: y))
                            continue
                        }
                    }
                    let level = min(WallMotion.levels - 1, Int(shown * Double(WallMotion.levels - 1) / 1.2))
                    guard level > 0 else { continue }
                    let k = Double(level) / Double(WallMotion.levels - 1)
                    let d = (1.0 + 1.8 * k) * (deep ? 0.75 : 1)
                    plain[layer][level].addEllipse(in: CGRect(x: x - d / 2, y: y - d / 2, width: d, height: d))
                }
            }
        }
        for layer in 0...1 {
            for level in 1..<WallMotion.levels {
                let k = Double(level) / Double(WallMotion.levels - 1)
                let alpha = (22 + 80 * k) / 255 * (layer == 0 ? 0.6 : 1)
                context.fill(plain[layer][level], with: .color(WallMotion.color(ink, alpha)))
            }
        }
        for hue in glints.indices {
            for level in 0..<WallMotion.litLevels where !lit[hue][level].isEmpty {
                let k = Double(level + 1) / Double(WallMotion.litLevels)
                func spots(_ d: Double, dx: Double = 0, dy: Double = 0) -> Path {
                    var p = Path()
                    for s in lit[hue][level] { p.addEllipse(in: CGRect(x: s.x + dx - d / 2, y: s.y + dy - d / 2, width: d, height: d)) }
                    return p
                }
                if dark { context.fill(spots(8 + 4 * k), with: .color(WallMotion.color(glints[hue], 46 * k / 255))) }
                context.fill(spots(2.2 + 1.4 * k), with: .color(WallMotion.color(glints[hue], (150 + 105 * k) / 255)))
                // The light caught: a small bright point to one side, toward where the light comes from.
                context.fill(spots(0.7 + 0.4 * k, dx: -0.55, dy: -0.6), with: .color(.white.opacity(235 * k / 255)))
            }
        }
    }
}
