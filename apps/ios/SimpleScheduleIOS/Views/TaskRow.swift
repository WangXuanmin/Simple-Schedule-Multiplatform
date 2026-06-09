import SwiftUI

struct TaskRow: View {
    @EnvironmentObject private var store: TaskStore
    let task: TaskItem
    let allowsUrgencyEditing: Bool
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 2)
                .fill(task.urgencyLevel.tint)
                .frame(width: 3)
                .opacity(task.urgencyLevel == .normal ? 0 : urgencyAccentOpacity)
                .padding(.vertical, 8)
                .padding(.trailing, 12)

            HStack(spacing: 12) {
                Button {
                    Task { await store.toggle(task) }
                } label: {
                    Image(systemName: task.completedAt == nil ? "circle" : "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(task.completedAt == nil ? deadlineColor : .green)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(task.completedAt == nil ? "完成任务" : "恢复任务")

                Button(action: onOpen) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(task.title)
                            .font(.headline)
                            .foregroundStyle(task.completedAt == nil ? .primary : .secondary)
                            .strikethrough(task.completedAt != nil)
                            .lineLimit(2)

                        HStack(spacing: 6) {
                            Image(systemName: deadlineIcon)
                            Text(task.deadlineAt, format: .dateTime.month().day().hour().minute())
                        }
                        .font(.caption)
                        .foregroundStyle(deadlineColor)
                    }
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())

                Spacer(minLength: 8)

                if allowsUrgencyEditing {
                    urgencyMenu
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var deadlineColor: Color {
        if task.completedAt != nil {
            return .secondary
        }

        let calendar = Calendar.current
        if task.deadlineAt < Date() {
            return .red
        }
        if calendar.isDateInToday(task.deadlineAt) {
            return .blue
        }
        return .secondary
    }

    private var deadlineIcon: String {
        guard task.completedAt == nil else { return "calendar" }
        let calendar = Calendar.current
        return task.deadlineAt < Date() || calendar.isDateInToday(task.deadlineAt)
            ? "calendar.badge.exclamationmark"
            : "calendar"
    }

    private var urgencyMenu: some View {
        Menu {
            ForEach(TaskUrgency.allCases) { level in
                Button {
                    Task { await store.updateUrgency(task, urgency: level) }
                } label: {
                    Label(level.title, systemImage: level.systemImage)
                }
            }
        } label: {
            Image(systemName: task.urgencyLevel.systemImage)
                .font(.headline)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(task.urgencyLevel.tint)
                .frame(width: 34, height: 34)
                .opacity(task.urgencyLevel == .normal ? 0.45 : completedOpacity)
                .accessibilityLabel("调整紧迫程度")
        }
        .buttonStyle(.plain)
        .disabled(store.isBusy)
    }

    private var completedOpacity: Double {
        task.completedAt == nil ? 1 : 0.55
    }

    private var urgencyAccentOpacity: Double {
        task.completedAt == nil ? 1 : 0.25
    }
}
