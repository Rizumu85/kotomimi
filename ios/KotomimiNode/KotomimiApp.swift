import SwiftUI
import UIKit

/// Kotomimi on an iPad or iPhone: lends the device's own speech recognition to Kotomimi on a computer, as the
/// Android app lends a phone (android/). iOS gives an app in the background no time of its own, so sharing lasts as
/// long as the app is in front: the door is closed when it leaves, and opened again when it comes back, and while it
/// is lent the screen does not lock by itself.
@main
struct KotomimiApp: App {
    @State private var hearing: Hearing
    @State private var lending: Lending
    @State private var text: TextStore
    @State private var check = SelfCheck()
    @AppStorage("look.appearance") private var appearance = "system"
    @Environment(\.scenePhase) private var scene

    init() {
        let hearing = Hearing()
        let text = TextStore()
        _hearing = State(initialValue: hearing)
        _text = State(initialValue: text)
        _lending = State(initialValue: Lending(hearing: hearing, text: text))
    }

    var body: some Scene {
        WindowGroup {
            Landscape {
            Home()
                .environment(hearing)
                .environment(lending)
                .environment(text)
                // The system says memory is short: the text models go, before the system ends the app for them.
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in lending.engine.release() }
                .environment(check)
                .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
                .task {
                    #if DEBUG
                    if let at = CommandLine.arguments.firstIndex(of: "-pretend"), at + 1 < CommandLine.arguments.count {
                        hearing.pretend()
                        lending.pretend(CommandLine.arguments[at + 1])
                        return
                    }
                    #endif
                    await hearing.refresh()
                }
                .onChange(of: scene, initial: true) { _, now in
                    #if DEBUG
                    if CommandLine.arguments.contains("-pretend") { return }
                    #endif
                    switch now {
                    case .active:
                        Task {
                            await hearing.refresh()
                            if lending.wanted, !hearing.ready.isEmpty, lending.phase == .off { lending.start() }
                        }
                    case .background:
                        if lending.phase != .off { lending.stop() }
                    default: break
                    }
                }
                // Lent, or fetching a model: the screen stays on.
                .onChange(of: lending.phase != .off || text.downloading, initial: true) { _, awake in
                    UIApplication.shared.isIdleTimerDisabled = awake
                }
            }
        }
    }
}

/// The page drawn across, for screenshots of the wide layout in the simulator, which does not turn (`-landscape`):
/// laid out at the screen's size turned, and turned back on the screen. Anywhere else, the page as it is.
private struct Landscape<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        #if DEBUG
        if CommandLine.arguments.contains("-landscape") {
            GeometryReader { box in
                content
                    .frame(width: box.size.height, height: box.size.width)
                    .rotationEffect(.degrees(-90))
                    .position(x: box.size.width / 2, y: box.size.height / 2)
            }
            .ignoresSafeArea()
        } else {
            content
        }
        #else
        content
        #endif
    }
}
