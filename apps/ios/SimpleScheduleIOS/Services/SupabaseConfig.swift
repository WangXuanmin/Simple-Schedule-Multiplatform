import Foundation

enum SupabaseConfig {
    static let url = URL(string: "https://vzojfajfpjdjeoavhtks.supabase.co")!
    static let anonKey = "sb_publishable_oVpjHxc8WK7c-aoPYtwOSw_aU0A1IUy"
}

struct AuthSession: Codable, Equatable {
    var userId: String
    var email: String
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date

    var needsRefresh: Bool {
        Date().addingTimeInterval(60) >= expiresAt
    }
}

enum SupabaseError: LocalizedError {
    case invalidResponse
    case authenticationRequired
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid Supabase response."
        case .authenticationRequired:
            return "Please sign in again."
        case .server(let message):
            return message
        }
    }
}
