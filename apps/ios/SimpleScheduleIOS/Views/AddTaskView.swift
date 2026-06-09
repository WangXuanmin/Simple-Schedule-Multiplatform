import SwiftUI

struct AddTaskView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: TaskStore
    @State private var title = ""
    @State private var deadlineAt = Date()
    @State private var urgency: TaskUrgency = .normal

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
            .navigationTitle("添加任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("添加") {
                        Task {
                            await store.createTask(title: title, deadlineAt: deadlineAt, urgency: urgency)
                            dismiss()
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

extension TaskUrgency {
    var tint: Color {
        switch self {
        case .normal: .secondary
        case .rush: .orange
        case .urgent: .red
        }
    }
}
