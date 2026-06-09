import SwiftData
import SwiftUI

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @EnvironmentObject private var store: TaskStore
    @State private var showingAddTask = false
    @State private var editingTask: TaskItem?

    var body: some View {
        NavigationStack {
            Group {
                if store.session == nil {
                    AuthView()
                        .toolbar(.hidden, for: .navigationBar)
                } else {
                    taskList
                        .navigationTitle("Simple Schedule")
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("退出") {
                                    store.signOut()
                                }
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                Button {
                                    Task { await store.sync() }
                                } label: {
                                    Image(systemName: "arrow.clockwise")
                                }
                                .disabled(store.isBusy)
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                Button {
                                    showingAddTask = true
                                } label: {
                                    Image(systemName: "plus")
                                }
                            }
                        }
                }
            }
            .sheet(isPresented: $showingAddTask) {
                AddTaskView()
            }
            .sheet(item: $editingTask) { task in
                EditTaskView(task: task)
            }
        }
        .onAppear {
            store.configure(modelContext: modelContext)
        }
    }

    private var taskList: some View {
        VStack(spacing: 0) {
            Picker("任务视图", selection: $store.selectedView) {
                ForEach(TaskListView.allCases) { view in
                    Text(view.title).tag(view)
                }
            }
            .pickerStyle(.segmented)
            .padding([.horizontal, .top])

            SummaryStrip(summary: store.summary)
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 4)

            if store.visibleTasks.isEmpty {
                ContentUnavailableView(
                    store.selectedView == .todo ? "没有待办任务" : "最近 7 天没有完成任务",
                    systemImage: store.selectedView == .todo ? "checklist" : "checkmark.circle",
                    description: Text(store.selectedView == .todo ? "点击右上角添加任务。" : "完成任务后会出现在这里。")
                )
            } else {
                List {
                    ForEach(store.visibleTasks) { task in
                        TaskRow(
                            task: task,
                            allowsUrgencyEditing: store.selectedView == .todo,
                            onOpen: { editingTask = task }
                        )
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    Task { await store.delete(task) }
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                    }
                }
                .listStyle(.insetGrouped)
            }

            if store.shouldShowSyncStatus {
                statusFooter
            }
        }
        .background(Color(.systemGroupedBackground))
        .refreshable {
            await store.sync()
        }
    }

    private var statusFooter: some View {
        HStack(spacing: 8) {
            if store.isBusy {
                ProgressView()
            }
            Text(store.message ?? store.syncState.label)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
            if store.pendingWriteCount > 0 {
                Text("\(store.pendingWriteCount) 待同步")
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.orange.opacity(0.14), in: Capsule())
                    .foregroundStyle(.orange)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private struct SummaryStrip: View {
    let summary: TaskSummary

    var body: some View {
        HStack(spacing: 8) {
            SummaryMetric(title: "今日/逾期", value: summary.dueOrOverdueCount, systemImage: "calendar.badge.exclamationmark", tint: .red)
            SummaryMetric(title: "加急/紧急", value: summary.priorityCount, systemImage: "exclamationmark.triangle.fill", tint: .orange)
            SummaryMetric(title: "最近完成", value: summary.recentCompletedCount, systemImage: "checkmark.circle.fill", tint: .green)
        }
    }
}

private struct SummaryMetric: View {
    let title: String
    let value: Int
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.subheadline)
                .foregroundStyle(tint)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 1) {
                Text("\(value)")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
