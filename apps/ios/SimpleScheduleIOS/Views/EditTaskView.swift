import SwiftUI

struct EditTaskView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: TaskStore

    let task: TaskItem
    @State private var title: String
    @State private var deadlineAt: Date
    @State private var urgency: TaskUrgency

    init(task: TaskItem) {
        self.task = task
        _title = State(initialValue: task.title)
        _deadlineAt = State(initialValue: task.deadlineAt)
        _urgency = State(initialValue: task.urgencyLevel)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("任务名称", text: $title)
                    DatePicker("截止时间", selection: $deadlineAt)
                }
                Section("紧迫程度") {
                    Picker("紧迫程度", selection: $urgency) {
                        ForEach(TaskUrgency.allCases) { level in
                            Image(systemName: level.systemImage)
                                .tag(level)
                                .accessibilityLabel(level.title)
                        }
                    }
                    .pickerStyle(.segmented)
                    .tint(urgency.tint)
                }
            }
            .navigationTitle("编辑任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        Task {
                            await store.updateTask(task, title: title, deadlineAt: deadlineAt, urgency: urgency)
                            dismiss()
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
