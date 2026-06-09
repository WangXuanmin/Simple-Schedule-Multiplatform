import Foundation
import SwiftData

enum TaskUrgency: String, CaseIterable, Identifiable {
    case normal
    case rush
    case urgent

    var id: String { rawValue }

    var title: String {
        switch self {
        case .normal: "普通"
        case .rush: "加急"
        case .urgent: "紧急"
        }
    }

    var systemImage: String {
        switch self {
        case .normal: "circle"
        case .rush: "bolt.fill"
        case .urgent: "exclamationmark.triangle.fill"
        }
    }

    var sortRank: Int {
        switch self {
        case .normal: 0
        case .rush: 1
        case .urgent: 2
        }
    }
}

@Model
final class TaskItem: Identifiable {
    @Attribute(.unique) var id: String
    var userId: String
    var title: String
    var deadlineAt: Date
    var completedAt: Date?
    var deletedAt: Date?
    var urgency: String = TaskUrgency.normal.rawValue
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String = UUID().uuidString,
        userId: String,
        title: String,
        deadlineAt: Date,
        completedAt: Date? = nil,
        deletedAt: Date? = nil,
        urgency: TaskUrgency = .normal,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id.lowercased()
        self.userId = userId.lowercased()
        self.title = title
        self.deadlineAt = deadlineAt
        self.completedAt = completedAt
        self.deletedAt = deletedAt
        self.urgency = urgency.rawValue
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    func update(from task: RemoteTask) {
        guard task.updatedAt >= updatedAt else { return }
        userId = task.userId.lowercased()
        title = task.title
        deadlineAt = task.deadlineAt
        completedAt = task.completedAt
        deletedAt = task.deletedAt
        urgency = task.urgency.rawValue
        createdAt = task.createdAt
        updatedAt = task.updatedAt
    }

    var remoteTask: RemoteTask {
        RemoteTask(
            id: id.lowercased(),
            userId: userId.lowercased(),
            title: title,
            deadlineAt: deadlineAt,
            completedAt: completedAt,
            deletedAt: deletedAt,
            urgency: urgencyLevel,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    var urgencyLevel: TaskUrgency {
        get { TaskUrgency(rawValue: urgency) ?? .normal }
        set { urgency = newValue.rawValue }
    }
}

@Model
final class PendingTaskWrite: Identifiable {
    @Attribute(.unique) var id: String
    var userId: String
    var taskId: String
    var createdAt: Date
    var lastError: String

    init(id: String = UUID().uuidString, userId: String, taskId: String, createdAt: Date = .now, lastError: String = "") {
        self.id = id
        self.userId = userId.lowercased()
        self.taskId = taskId.lowercased()
        self.createdAt = createdAt
        self.lastError = lastError
    }
}

struct RemoteTask: Identifiable, Equatable {
    var id: String
    var userId: String
    var title: String
    var deadlineAt: Date
    var completedAt: Date?
    var deletedAt: Date?
    var urgency: TaskUrgency
    var createdAt: Date
    var updatedAt: Date
}
