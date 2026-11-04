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
    @State private var check = SelfCheck()
    @AppStorage("look.appearance") private var appearance = "system"
    @Environment(\.scenePhase) private var scene

    init() {
        let hearing = Hearing()
        _hearing = State(initialValue: hearing)
        _lending = State(initialValue: Lending(hearing: hearing))
    }

    var body: some Scene {
        WindowGroup {
            Home()
                .environment(hearing)
                .environment(lending)
                .environment(check)
                .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
                .task { await hearing.refresh() }
                .onChange(of: scene, initial: true) { _, now in
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
                .onChange(of: lending.phase) { _, phase in
                    UIApplication.shared.isIdleTimerDisabled = phase != .off
                }
        }
    }
}
