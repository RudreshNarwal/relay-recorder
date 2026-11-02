import Foundation
import Synchronization

public struct CaptureFormat: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public let framesPerSecond = 30
    public let estimatedBytesPerMinute: Int64
    public let limitedBySource: Bool
    public static let diskReserve: Int64 = 512 * 1024 * 1024

    public static func preflight(sourceWidth: Int, sourceHeight: Int, requestedWidth: Int, requestedHeight: Int, hardwareEncoder: (Int, Int) -> Bool, availableBytes: Int64, hasAudio: Bool, deniedPermission: String? = nil) throws -> Self {
        if let permission = deniedPermission { throw RelayError.server("\(permission) permission is denied. Enable Relay in System Settings → Privacy & Security, then retry.") }
        guard sourceWidth >= 2, sourceHeight >= 2, requestedWidth >= 2, requestedHeight >= 2, requestedWidth <= 3840, requestedHeight <= 2160 else { throw RelayError.server("The selected source or resolution is unavailable. Load sources and choose again.") }
        let scale = min(1, Double(requestedWidth) / Double(sourceWidth), Double(requestedHeight) / Double(sourceHeight))
        let width = max(2, Int(Double(sourceWidth) * scale) / 2 * 2)
        let height = max(2, Int(Double(sourceHeight) * scale) / 2 * 2)
        guard hardwareEncoder(width, height) else { throw RelayError.server("A hardware H.264 encoder is unavailable for \(width)×\(height). Close other recording apps, choose a lower resolution, and retry.") }
        let perMinute = Int64((Double(width * height * 5) + (hasAudio ? 192_000 : 0)) / 8 * 60 * 1.1)
        guard availableBytes >= diskReserve + perMinute else { throw RelayError.server("Insufficient free disk space. Free at least \(ByteCountFormatter.string(fromByteCount: diskReserve + perMinute, countStyle: .file)) for a minute of capture and a recovery reserve, then retry.") }
        return Self(width: width, height: height, estimatedBytesPerMinute: perMinute, limitedBySource: scale == 1 && (sourceWidth < requestedWidth || sourceHeight < requestedHeight))
    }
}

/// Main-actor clients own this value. A generation stays occupied until cleanup
/// finishes, so cancellation cannot admit a new start while old setup unwinds.
public struct CaptureLifecycle: Sendable {
    public enum Phase: String, Sendable { case idle, preparing, preview, countdown, recording, paused, finishing, canceling }
    public private(set) var phase: Phase = .idle
    public private(set) var generation: UInt64 = 0
    private var cleanup = CaptureCleanup(completed: true)
    public init() {}
    public mutating func beginPreparation() throws -> UInt64 {
        guard phase == .idle else { throw RelayError.invalidState }
        generation &+= 1; cleanup = CaptureCleanup(completed: false); phase = .preparing; return generation
    }
    public mutating func prepared(_ token: UInt64, record: Bool) -> Bool {
        guard token == generation, phase == .preparing else { return false }
        phase = record ? .countdown : .preview; return true
    }
    public mutating func beginCountdown() throws -> UInt64 {
        guard phase == .preview else { throw RelayError.invalidState }
        phase = .countdown; return generation
    }
    public mutating func started(_ token: UInt64) -> Bool {
        guard token == generation, phase == .countdown else { return false }
        phase = .recording; return true
    }
    public mutating func setPaused(_ paused: Bool) throws {
        guard phase == (paused ? .recording : .paused) else { throw RelayError.invalidState }
        phase = paused ? .paused : .recording
    }
    public mutating func requestStop() {
        switch phase {
        case .preparing, .preview, .countdown: phase = .canceling
        case .recording, .paused: phase = .finishing
        default: break
        }
    }
    public func acceptsCallbacks(_ token: UInt64) -> Bool {
        token == generation && [.preparing, .preview, .countdown, .recording, .paused].contains(phase)
    }
    public mutating func finished(_ token: UInt64) {
        guard token == generation else { return }
        phase = .idle
        cleanup.complete()
    }
    /// Await this generation's final media/journal writes, including a stop queued behind pause.
    public func waitForCleanup() async { await cleanup.wait() }
}

private final class CaptureCleanup: Sendable {
    private struct State {
        var completed: Bool
        var waiters: [CheckedContinuation<Void, Never>] = []
    }
    private let state: Mutex<State>
    init(completed: Bool) { state = Mutex(State(completed: completed)) }
    func wait() async {
        await withCheckedContinuation { continuation in
            let ready = state.withLock { state in
                if state.completed { return true }
                state.waiters.append(continuation); return false
            }
            if ready { continuation.resume() }
        }
    }
    func complete() {
        let waiters = state.withLock { state in
            state.completed = true
            let waiters = state.waiters; state.waiters.removeAll(); return waiters
        }
        for waiter in waiters { waiter.resume() }
    }
}
