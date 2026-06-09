import Foundation

struct SupabaseClient {
    private let baseURL = SupabaseConfig.url
    private let anonKey = SupabaseConfig.anonKey
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601WithFractions
        self.decoder = decoder

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601WithFractions
        self.encoder = encoder
    }

    func signIn(email: String, password: String) async throws -> AuthSession {
        var components = URLComponents(url: baseURL.appending(path: "auth/v1/token"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        var request = baseRequest(url: components.url!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": email,
            "password": password
        ])
        return try await authSession(from: request)
    }

    func signUp(email: String, password: String) async throws -> AuthSession? {
        var request = baseRequest(url: baseURL.appending(path: "auth/v1/signup"))
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": email,
            "password": password
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        let auth = try decoder.decode(AuthResponse.self, from: data)
        guard let accessToken = auth.accessToken, let refreshToken = auth.refreshToken else {
            return nil
        }
        return auth.session(accessToken: accessToken, refreshToken: refreshToken)
    }

    func refresh(_ session: AuthSession) async throws -> AuthSession {
        var components = URLComponents(url: baseURL.appending(path: "auth/v1/token"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        var request = baseRequest(url: components.url!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "refresh_token": session.refreshToken
        ])
        return try await authSession(from: request)
    }

    func fetchTasks(session: AuthSession) async throws -> [RemoteTask] {
        var components = URLComponents(url: baseURL.appending(path: "rest/v1/tasks"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "select", value: "*"),
            URLQueryItem(name: "user_id", value: "eq.\(session.userId)"),
            URLQueryItem(name: "order", value: "updated_at.asc")
        ]
        var request = authenticatedRequest(url: components.url!, session: session)
        request.httpMethod = "GET"

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        return try decoder.decode([DbTask].self, from: data).map(\.remoteTask)
    }

    func upsertTask(_ task: RemoteTask, session: AuthSession) async throws {
        var components = URLComponents(url: baseURL.appending(path: "rest/v1/tasks"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "on_conflict", value: "id")]
        var request = authenticatedRequest(url: components.url!, session: session)
        request.httpMethod = "POST"
        request.setValue("resolution=merge-duplicates,return=minimal", forHTTPHeaderField: "Prefer")
        request.httpBody = try encoder.encode([DbTask(task: task)])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
    }

    private func authSession(from request: URLRequest) async throws -> AuthSession {
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        let auth = try decoder.decode(AuthResponse.self, from: data)
        guard let accessToken = auth.accessToken, let refreshToken = auth.refreshToken else {
            throw SupabaseError.invalidResponse
        }
        return auth.session(accessToken: accessToken, refreshToken: refreshToken)
    }

    private func baseRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func authenticatedRequest(url: URL, session: AuthSession) -> URLRequest {
        var request = baseRequest(url: url)
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else {
            throw SupabaseError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? decoder.decode(ErrorResponse.self, from: data).message)
                ?? String(data: data, encoding: .utf8)
                ?? "Supabase request failed."
            throw SupabaseError.server(message)
        }
    }
}

private struct AuthResponse: Codable {
    var accessToken: String?
    var refreshToken: String?
    var expiresIn: TimeInterval?
    var user: AuthUser

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case user
    }

    func session(accessToken: String, refreshToken: String) -> AuthSession {
        AuthSession(
            userId: user.id.lowercased(),
            email: user.email ?? "",
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: Date().addingTimeInterval(expiresIn ?? 3600)
        )
    }
}

private struct AuthUser: Codable {
    var id: String
    var email: String?
}

private struct ErrorResponse: Codable {
    var message: String?
    var errorDescription: String?
    var msg: String?

    enum CodingKeys: String, CodingKey {
        case message
        case errorDescription = "error_description"
        case msg
    }
}

private struct DbTask: Codable {
    var id: String
    var userId: String
    var title: String
    var deadlineAt: Date
    var completedAt: Date?
    var deletedAt: Date?
    var urgency: String?
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case title
        case deadlineAt = "deadline_at"
        case completedAt = "completed_at"
        case deletedAt = "deleted_at"
        case urgency
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(task: RemoteTask) {
        id = task.id.lowercased()
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
            urgency: TaskUrgency(rawValue: urgency ?? "") ?? .normal,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

private extension JSONDecoder.DateDecodingStrategy {
    static let iso8601WithFractions = custom { decoder in
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        if let date = ISO8601DateFormatter.withFractions.date(from: value)
            ?? ISO8601DateFormatter.withoutFractions.date(from: value) {
            return date
        }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO8601 date: \(value)")
    }
}

private extension JSONEncoder.DateEncodingStrategy {
    static let iso8601WithFractions = custom { date, encoder in
        var container = encoder.singleValueContainer()
        try container.encode(ISO8601DateFormatter.withFractions.string(from: date))
    }
}

private extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let withoutFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
