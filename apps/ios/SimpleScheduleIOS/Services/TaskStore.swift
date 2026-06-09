import Foundation
import SwiftData

enum TaskListView: String, CaseIterable, Identifiable {
    case todo
    case completed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .todo: "Todo"
        case .completed: "Completed"
        }
    }
}

enum SyncState: Equatable {
    case idle
    case syncing
    case offline
    case failed(String)

    var label: String {
        switch self {
        case .idle: "已同步"
        case .syncing: "正在同步..."
        case .offline: "离线，已保存到本机"
        case .failed(let message): "同步失败：\(message)"
        }
    }
}

struct TaskSummary {
    var dueOrOverdueCount: Int
    var priorityCount: Int
    var recentCompletedCount: Int
}

@MainActor
final class TaskStore: ObservableObject {
    @Published private(set) var session: AuthSession?
    @Published private(set) var tasks: [TaskItem] = []
    @Published var selectedView: TaskListView = .todo
    @Published var syncState: SyncState = .idle
    @Published var message: String?
    @Published var isBusy = false

    private let client = SupabaseClient()
    private let sessionStorage = SessionStorage()
    private var modelContext: ModelContext?
    private let legacySessionKey = "simpleSchedule.authSession"
    private let completedRetention: TimeInterval = 7 * 24 * 60 * 60

    var visibleTasks: [TaskItem] {
        switch selectedView {
        case .todo:
            tasks
                .filter { $0.deletedAt == nil && $0.completedAt == nil }
                .sorted {
                    if $0.deadlineAt == $1.deadlineAt {
                        if $0.urgencyLevel.sortRank != $1.urgencyLevel.sortRank {
                            return $0.urgencyLevel.sortRank > $1.urgencyLevel.sortRank
                        }
                        return $0.createdAt < $1.createdAt
                    }
                    return $0.deadlineAt < $1.deadlineAt
                }
        case .completed:
            tasks
                .filter { task in
                    guard task.deletedAt == nil, let completedAt = task.completedAt else { return false }
                    return Date().timeIntervalSince(completedAt) < completedRetention
                }
                .sorted {
                    ($0.completedAt ?? $0.updatedAt) > ($1.completedAt ?? $1.updatedAt)
                }
        }
    }

    var pendingWriteCount: Int {
        guard let context = modelContext, let userId = session?.userId else { return 0 }
        let writes = (try? context.fetch(FetchDescriptor<PendingTaskWrite>())) ?? []
        return writes.filter { $0.userId == userId }.count
    }

    var summary: TaskSummary {
        let calendar = Calendar.current
        let now = Date()
        let visibleTodoTasks = tasks.filter { $0.deletedAt == nil && $0.completedAt == nil }
        let recentCompletedTasks = tasks.filter { task in
            guard task.deletedAt == nil, let completedAt = task.completedAt else { return false }
            return now.timeIntervalSince(completedAt) < completedRetention
        }

        return TaskSummary(
            dueOrOverdueCount: visibleTodoTasks.filter { $0.deadlineAt < now || calendar.isDateInToday($0.deadlineAt) }.count,
            priorityCount: visibleTodoTasks.filter { $0.urgencyLevel != .normal }.count,
            recentCompletedCount: recentCompletedTasks.count
        )
    }

    var shouldShowSyncStatus: Bool {
        isBusy || syncState != .idle || message != nil || pendingWriteCount > 0
    }

    func configure(modelContext: ModelContext) {
        guard self.modelContext == nil else { return }
        self.modelContext = modelContext
        restoreSession()
        deduplicateLocalTasks()
        loadLocalTasks()

        if session != nil {
            Task { await sync() }
        }
    }

    func signIn(email: String, password: String) async {
        await runBusyOperation {
            let nextSession = try await client.signIn(email: email, password: password)
            setSession(nextSession)
            loadLocalTasks()
            await sync()
        }
    }

    func signUp(email: String, password: String) async {
        await runBusyOperation {
            if let nextSession = try await client.signUp(email: email, password: password) {
                setSession(nextSession)
                loadLocalTasks()
                await sync()
            } else {
                message = "注册邮件已发送，请确认邮箱后再登录。"
            }
        }
    }

    func signOut() {
        session = nil
        tasks = []
        message = nil
        syncState = .idle
        sessionStorage.clear()
        UserDefaults.standard.removeObject(forKey: legacySessionKey)
    }

    func loadLocalTasks() {
        guard let context = modelContext, let userId = session?.userId else {
            tasks = []
            return
        }
        let allTasks = (try? context.fetch(FetchDescriptor<TaskItem>())) ?? []
        let userTasks = allTasks.filter { $0.userId == userId }
        normalizeStoredTasks(userTasks)
        tasks = userTasks
    }

    func sync() async {
        guard session != nil else { return }
        isBusy = true
        syncState = .syncing
        defer { isBusy = false }

        do {
            let activeSession = try await validSession()
            try await flushPendingWrites(session: activeSession)
            let remoteTasks = try await client.fetchTasks(session: activeSession)
            merge(remoteTasks: remoteTasks)
            deduplicateLocalTasks()
            loadLocalTasks()
            syncState = .idle
            message = pendingWriteCount == 0 ? nil : "\(pendingWriteCount) 条待联网同步"
        } catch {
            syncState = .failed(error.localizedDescription)
            message = "本地数据仍可使用，稍后可点刷新重试。"
        }
    }

    func createTask(title: String, deadlineAt: Date, urgency: TaskUrgency = .normal) async {
        guard let context = modelContext, let userId = session?.userId else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }

        let now = Date()
        let task = TaskItem(
            userId: userId,
            title: cleanTitle,
            deadlineAt: deadlineAt,
            urgency: urgency,
            createdAt: now,
            updatedAt: now
        )
        context.insert(task)
        saveContext()
        deduplicateLocalTasks()
        loadLocalTasks()
        await writeCloudOrQueue(task.remoteTask)
    }

    func updateTask(_ task: TaskItem, title: String, deadlineAt: Date, urgency: TaskUrgency) async {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }
        guard task.title != cleanTitle || task.deadlineAt != deadlineAt || task.urgencyLevel != urgency else { return }

        task.title = cleanTitle
        task.deadlineAt = deadlineAt
        task.urgencyLevel = urgency
        task.updatedAt = Date()
        saveContext()
        loadLocalTasks()
        await writeCloudOrQueue(task.remoteTask)
    }

    func updateUrgency(_ task: TaskItem, urgency: TaskUrgency) async {
        guard task.urgencyLevel != urgency else { return }
        task.urgencyLevel = urgency
        task.updatedAt = Date()
        saveContext()
        loadLocalTasks()
        await writeCloudOrQueue(task.remoteTask)
    }

    func toggle(_ task: TaskItem) async {
        let now = Date()
        task.completedAt = task.completedAt == nil ? now : nil
        task.updatedAt = now
        saveContext()
        loadLocalTasks()
        await writeCloudOrQueue(task.remoteTask)
    }

    func delete(_ task: TaskItem) async {
        let now = Date()
        task.deletedAt = now
        task.updatedAt = now
        saveContext()
        loadLocalTasks()
        await writeCloudOrQueue(task.remoteTask)
    }

    private func runBusyOperation(_ operation: () async throws -> Void) async {
        isBusy = true
        message = nil
        defer { isBusy = false }

        do {
            try await operation()
        } catch {
            message = error.localizedDescription
            syncState = .failed(error.localizedDescription)
        }
    }

    private func writeCloudOrQueue(_ task: RemoteTask) async {
        do {
            let activeSession = try await validSession()
            try await client.upsertTask(task, session: activeSession)
            deletePendingWrite(taskId: task.id)
            syncState = .idle
            message = nil
        } catch {
            queuePendingWrite(taskId: task.id, error: error)
            syncState = .offline
            message = "\(pendingWriteCount) 条待联网同步"
        }
    }

    private func validSession() async throws -> AuthSession {
        guard let current = session else { throw SupabaseError.authenticationRequired }
        guard current.needsRefresh else { return current }

        let refreshed = try await client.refresh(current)
        setSession(refreshed)
        return refreshed
    }

    private func flushPendingWrites(session: AuthSession) async throws {
        guard let context = modelContext else { return }
        let writes = ((try? context.fetch(FetchDescriptor<PendingTaskWrite>())) ?? [])
            .filter { $0.userId == session.userId }
            .sorted { $0.createdAt < $1.createdAt }

        for write in writes {
            guard let task = localTask(id: write.taskId) else {
                context.delete(write)
                saveContext()
                continue
            }

            do {
                try await client.upsertTask(task.remoteTask, session: session)
                context.delete(write)
                saveContext()
            } catch {
                write.lastError = error.localizedDescription
                saveContext()
                throw error
            }
        }
    }

    private func merge(remoteTasks: [RemoteTask]) {
        guard let context = modelContext else { return }

        for remoteTask in remoteTasks {
            if let existing = localTask(id: remoteTask.id) {
                existing.update(from: remoteTask)
            } else {
                context.insert(TaskItem(
                    id: remoteTask.id,
                    userId: remoteTask.userId,
                    title: remoteTask.title,
                    deadlineAt: remoteTask.deadlineAt,
                    completedAt: remoteTask.completedAt,
                    deletedAt: remoteTask.deletedAt,
                    urgency: remoteTask.urgency,
                    createdAt: remoteTask.createdAt,
                    updatedAt: remoteTask.updatedAt
                ))
            }
        }
        saveContext()
    }

    private func localTask(id: String) -> TaskItem? {
        guard let context = modelContext else { return nil }
        let allTasks = (try? context.fetch(FetchDescriptor<TaskItem>())) ?? []
        return allTasks.first { $0.id.lowercased() == id.lowercased() }
    }

    private func deduplicateLocalTasks() {
        guard let context = modelContext else { return }
        let allTasks = (try? context.fetch(FetchDescriptor<TaskItem>())) ?? []
        let groupedTasks = Dictionary(grouping: allTasks) { task in
            "\(task.userId.lowercased()):\(task.id.lowercased())"
        }

        for duplicates in groupedTasks.values {
            if duplicates.count == 1 {
                let task = duplicates[0]
                task.id = task.id.lowercased()
                task.userId = task.userId.lowercased()
                continue
            }

            let canonicalId = duplicates[0].id.lowercased()
            let keeper = duplicates.first { $0.id == canonicalId }
                ?? duplicates.max { $0.updatedAt < $1.updatedAt }
                ?? duplicates[0]

            for duplicate in duplicates where duplicate !== keeper {
                if duplicate.updatedAt > keeper.updatedAt {
                    keeper.update(from: duplicate.remoteTask)
                }
                context.delete(duplicate)
            }

            if keeper.id != canonicalId {
                keeper.id = canonicalId
            }
            keeper.userId = keeper.userId.lowercased()
        }

        saveContext()
    }

    private func normalizeStoredTasks(_ tasks: [TaskItem]) {
        var didChange = false

        for task in tasks {
            let normalizedId = task.id.lowercased()
            let normalizedUserId = task.userId.lowercased()
            let normalizedUrgency = task.urgencyLevel.rawValue

            if task.id != normalizedId {
                task.id = normalizedId
                didChange = true
            }
            if task.userId != normalizedUserId {
                task.userId = normalizedUserId
                didChange = true
            }
            if task.urgency != normalizedUrgency {
                task.urgency = normalizedUrgency
                didChange = true
            }
        }

        if didChange {
            saveContext()
        }
    }

    private func queuePendingWrite(taskId: String, error: Error) {
        guard let context = modelContext, let userId = session?.userId else { return }
        let task = localTask(id: taskId)
        let normalizedTaskId = taskId.lowercased()
        let pendingId = "\(normalizedTaskId):\(task?.updatedAt.timeIntervalSince1970 ?? Date().timeIntervalSince1970)"
        let allWrites = (try? context.fetch(FetchDescriptor<PendingTaskWrite>())) ?? []

        if let existing = allWrites.first(where: { $0.id == pendingId }) {
            existing.lastError = error.localizedDescription
        } else {
            context.insert(PendingTaskWrite(
                id: pendingId,
                userId: userId,
                taskId: normalizedTaskId,
                lastError: error.localizedDescription
            ))
        }
        saveContext()
    }

    private func deletePendingWrite(taskId: String) {
        guard let context = modelContext, let userId = session?.userId else { return }
        let writes = (try? context.fetch(FetchDescriptor<PendingTaskWrite>())) ?? []
        for write in writes where write.userId == userId && write.taskId.lowercased() == taskId.lowercased() {
            context.delete(write)
        }
        saveContext()
    }

    private func setSession(_ nextSession: AuthSession) {
        session = nextSession
        sessionStorage.save(nextSession)
        UserDefaults.standard.removeObject(forKey: legacySessionKey)
    }

    private func restoreSession() {
        if let savedSession = sessionStorage.load() {
            session = savedSession
            return
        }

        guard let data = UserDefaults.standard.data(forKey: legacySessionKey),
              let legacySession = try? JSONDecoder().decode(AuthSession.self, from: data) else {
            return
        }
        setSession(legacySession)
    }

    private func saveContext() {
        do {
            try modelContext?.save()
        } catch {
            message = error.localizedDescription
        }
    }
}
