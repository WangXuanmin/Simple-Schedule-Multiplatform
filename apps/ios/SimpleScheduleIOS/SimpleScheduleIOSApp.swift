import SwiftData
import SwiftUI

@main
struct SimpleScheduleIOSApp: App {
    @StateObject private var store = TaskStore()
    private let modelContainer = SimpleScheduleModelContainer.make()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
        .modelContainer(modelContainer)
    }
}
