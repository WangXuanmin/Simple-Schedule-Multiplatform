import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var store: TaskStore
    @State private var email = ""
    @State private var password = ""
    @State private var mode: AuthMode = .signIn

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 10) {
                Text("Simple Schedule")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.primary)
                Text("登录同一个 Supabase 账号后，iOS 与 Windows 会自动同步任务。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 14) {
                Picker("登录方式", selection: $mode) {
                    ForEach(AuthMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                TextField("邮箱", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)

                SecureField("密码", text: $password)
                    .textContentType(mode == .signIn ? .password : .newPassword)
                    .textFieldStyle(.roundedBorder)

                Button {
                    Task {
                        if mode == .signIn {
                            await store.signIn(email: email, password: password)
                        } else {
                            await store.signUp(email: email, password: password)
                        }
                    }
                } label: {
                    HStack {
                        if store.isBusy {
                            ProgressView()
                        }
                        Text(mode.buttonTitle)
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isBusy || email.isEmpty || password.count < 6)
            }

            if let message = store.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()
        }
        .padding(24)
        .background(Color(.systemGroupedBackground))
    }
}

private enum AuthMode: String, CaseIterable, Identifiable {
    case signIn
    case signUp

    var id: String { rawValue }
    var title: String { self == .signIn ? "登录" : "注册" }
    var buttonTitle: String { self == .signIn ? "登录并同步" : "注册账号" }
}
