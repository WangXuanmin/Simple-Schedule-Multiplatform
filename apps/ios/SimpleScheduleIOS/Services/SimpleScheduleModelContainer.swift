import SwiftData

enum SimpleScheduleModelContainer {
    static func make() -> ModelContainer {
        let schema = Schema([
            TaskItem.self,
            PendingTaskWrite.self
        ])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)

        do {
            return try ModelContainer(for: schema, configurations: [configuration])
        } catch {
            fatalError("Could not create SwiftData ModelContainer: \(error)")
        }
    }
}
