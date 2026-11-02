import Foundation
import CryptoKit

public struct ModelArtifact: Codable, Sendable {
    public let path: String
    public let size: Int64
    public let sha256: String
    public init(path: String, size: Int64, sha256: String) { self.path = path; self.size = size; self.sha256 = sha256 }
}
public struct ParakeetManifest: Codable, Sendable {
    public let repository: String
    public let revision: String
    public let files: [ModelArtifact]
    public var downloadBytes: Int64 { files.reduce(0) { $0 + $1.size } }
    public static func bundled() throws -> ParakeetManifest {
        guard let url = Bundle.module.url(forResource: "parakeet-v3", withExtension: "json", subdirectory: "Resources") else { throw RelayError.server("Parakeet model manifest is missing. Reinstall Relay.") }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }
}
public enum ModelIntegrity {
    /// Hash immutable model files before loading. Partial downloads never count as installed files.
    /// `containment` bounds where symlinks may point; a shared cache links model files across sibling folders.
    public static func verify(directory: URL, files: [ModelArtifact], containment: URL? = nil) throws {
        let root = (containment ?? directory).resolvingSymlinksInPath().standardizedFileURL.path + "/"
        for artifact in files {
            try Task.checkCancellation()
            guard !artifact.path.hasPrefix("/"), !artifact.path.split(separator: "/").contains("..") else { throw RelayError.invalidMedia }
            let url = directory.appendingPathComponent(artifact.path).resolvingSymlinksInPath().standardizedFileURL
            guard url.path.hasPrefix(root), let size = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]).fileSize, Int64(size) == artifact.size else { throw RelayError.server("Parakeet model is incomplete: \(artifact.path). Download or repair the model.") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
                try Task.checkCancellation(); hash.update(data: data)
            }
            guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == artifact.sha256 else { throw RelayError.server("Parakeet checksum failed: \(artifact.path). Remove and download the model again.") }
        }
    }
}
