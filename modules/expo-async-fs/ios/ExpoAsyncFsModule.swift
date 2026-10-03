import ExpoModulesCore
import Foundation

public class ExpoAsyncFsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoAsyncFs")

    Events("onDownloadProgress")

    // Posted by expo-continued-processing when the system expires its task:
    // stop network work immediately, without a JS round trip.
    OnCreate {
      NotificationCenter.default.addObserver(
        forName: Notification.Name("ExpoAsyncFsCancelAllDownloads"),
        object: nil,
        queue: nil
      ) { _ in ActiveDownloads.cancelAll() }
    }

    AsyncFunction("listDirectoryAsync") { (uri: String) -> [String] in
      return try FileManager.default.contentsOfDirectory(atPath: Self.resolvePath(uri))
    }

    AsyncFunction("getDirectorySizeAsync") { (uri: String) -> Int in
      return Self.directorySize(at: Self.fileUrl(uri))
    }

    // One off-thread call that returns each entry's name + size + type, so
    // callers avoid a sync .exists/.size stat per child on the JS thread
    // (expo-file-system's .exists/.size are sync-only). Used by
    // reconcileImageCache to walk the cover-art cache without blocking JS.
    AsyncFunction("listDirectoryWithSizesAsync") { (uri: String) -> [[String: Any]] in
      let url = Self.fileUrl(uri)
      let fm = FileManager.default
      let names = try fm.contentsOfDirectory(atPath: url.path)
      return names.map { name in
        let childPath = url.appendingPathComponent(name).path
        var isDir: ObjCBool = false
        fm.fileExists(atPath: childPath, isDirectory: &isDir)
        let size: Int = isDir.boolValue
          ? 0
          : ((try? fm.attributesOfItem(atPath: childPath)[.size] as? Int) ?? 0)
        return [
          "name": name,
          "size": size,
          "isDirectory": isDir.boolValue,
        ]
      }
    }

    // Off-thread existence + size + type stat. Single call so a render-path
    // consumer can confirm a file without a sync .exists/.size on the JS
    // thread (expo-file-system's are sync-only). `size` is 0 for missing
    // entries and directories.
    AsyncFunction("statAsync") { (uri: String) -> [String: Any] in
      let path = Self.resolvePath(uri)
      let fm = FileManager.default
      var isDir: ObjCBool = false
      let exists = fm.fileExists(atPath: path, isDirectory: &isDir)
      let size: Int = (exists && !isDir.boolValue)
        ? ((try? fm.attributesOfItem(atPath: path)[.size] as? Int) ?? 0)
        : 0
      return [
        "exists": exists,
        "size": size,
        "isDirectory": isDir.boolValue,
      ]
    }

    // Off-thread file delete. Returns true if a file existed and was deleted.
    AsyncFunction("deleteFileAsync") { (uri: String) -> Bool in
      let path = Self.resolvePath(uri)
      let fm = FileManager.default
      guard fm.fileExists(atPath: path) else { return false }
      try fm.removeItem(atPath: path)
      return true
    }

    // Off-thread RECURSIVE directory delete (whole cache wipe on logout /
    // clear-cache). expo-file-system's Directory.delete is sync-only and would
    // unlink potentially thousands of files on the JS thread. FileManager's
    // removeItem is recursive for directories.
    AsyncFunction("deleteDirectoryAsync") { (uri: String) -> Bool in
      let path = Self.resolvePath(uri)
      let fm = FileManager.default
      guard fm.fileExists(atPath: path) else { return false }
      try fm.removeItem(atPath: path)
      return true
    }

    // Register before async dispatch so a cancellation cannot miss a pending worker.
    Function("prepareDownload") { (downloadId: String) in
      ActiveDownloads.prepare(downloadId)
    }

    AsyncFunction("downloadFileAsyncWithProgress") { (urlString: String, destinationUri: String, downloadId: String) -> [String: Any] in
      let result = try await self.download(urlString, destinationUri, downloadId, validateAudio: false)
      return ["uri": result["uri"]!, "bytes": result["bytes"]!]
    }

    // Audio variant: never throws for an HTTP-level failure. Non-2xx and
    // non-audio bodies (a Subsonic XML/JSON error returned with HTTP 200)
    // resolve with `rejected` set and nothing left at the destination.
    AsyncFunction("downloadAudioFileAsync") { (urlString: String, destinationUri: String, downloadId: String) -> [String: Any] in
      return try await self.download(urlString, destinationUri, downloadId, validateAudio: true)
    }

    AsyncFunction("cancelDownloadAsync") { (downloadId: String) -> Bool in
      return ActiveDownloads.cancel(downloadId)
    }
  }

  private func download(
    _ urlString: String,
    _ destinationUri: String,
    _ downloadId: String,
    validateAudio: Bool
  ) async throws -> [String: Any] {
    let transfer = ActiveDownloads.begin(downloadId)
    defer { ActiveDownloads.remove(downloadId, transfer) }
    guard let url = URL(string: urlString) else {
      throw DownloadError.invalidUrl
    }
    // Remote URL above keeps URL(string:); the destination is a local file
    // path, so resolve it via the space-tolerant resolver (a literal space
    // would make URL(string:) nil and fail every download to such a path).
    let destUrl = Self.fileUrl(destinationUri)

    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData

    let config = URLSessionConfiguration.default
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil

    var lastEventTime: TimeInterval = 0
    let delegate = DownloadProgressDelegate(
      destinationUrl: destUrl,
      validateAudio: validateAudio,
      onProgress: { [weak self] bytesWritten, totalBytes in
        let now = ProcessInfo.processInfo.systemUptime
        let isComplete = totalBytes > 0 && bytesWritten >= totalBytes
        guard now - lastEventTime >= 0.1 || isComplete else { return }
        lastEventTime = now
        self?.sendEvent("onDownloadProgress", [
          "downloadId": downloadId,
          "bytesWritten": bytesWritten,
          "totalBytes": totalBytes,
        ])
      }
    )

    let session = URLSession(
      configuration: config,
      delegate: delegate,
      delegateQueue: nil
    )

    defer { session.finishTasksAndInvalidate() }

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      delegate.continuation = continuation
      let task = session.downloadTask(with: request)
      if ActiveDownloads.attach(transfer, task) {
        task.resume()
      } else {
        delegate.continuation = nil
        continuation.resume(throwing: DownloadError.cancelled)
        task.cancel()
      }
    }

    let fileSize = delegate.rejected == nil
      ? ((try? FileManager.default.attributesOfItem(atPath: destUrl.path)[.size] as? Int64) ?? 0)
      : 0

    var result: [String: Any] = [
      "uri": destUrl.absoluteString,
      "bytes": fileSize,
      "status": delegate.statusCode,
    ]
    if let rejected = delegate.rejected { result["rejected"] = rejected }
    if let retryAfter = delegate.retryAfterSeconds { result["retryAfterSeconds"] = retryAfter }
    return result
  }

  /// Resolve a file URI (or bare path) to a filesystem path. Mirrors the
  /// expo-image-resize resolver: URL(string:) percent-decodes a well-formed
  /// file:// URI, but returns nil when the URI carries a literal (unencoded)
  /// space — in which case we strip the scheme so paths with spaces still
  /// resolve instead of silently failing the whole operation. A bare path
  /// (no scheme) is returned unchanged.
  private static func resolvePath(_ uri: String) -> String {
    if uri.hasPrefix("file://") {
      return URL(string: uri)?.path ?? String(uri.dropFirst("file://".count))
    }
    return uri
  }

  /// Convenience for the call sites that need a file URL rather than a path.
  private static func fileUrl(_ uri: String) -> URL {
    return URL(fileURLWithPath: resolvePath(uri))
  }

  private static func directorySize(at url: URL) -> Int {
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(
      at: url,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles]
    ) else { return 0 }

    var total = 0
    for case let fileURL as URL in enumerator {
      total += (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }
    return total
  }
}

private enum DownloadError: Error, LocalizedError {
  case invalidUrl
  case invalidDestination
  case httpError(Int)
  case cancelled

  var errorDescription: String? {
    switch self {
    // Fixed English text: JS recognises a cancelled transfer by it, and
    // URLError's own description is localized.
    case .cancelled: return "cancelled"
    case .invalidUrl: return "Invalid download URL"
    case .invalidDestination: return "Invalid destination path"
    case .httpError(let code): return "Download failed with HTTP status \(code)"
    }
  }
}

/// Uses URLSession.downloadTask with a delegate — the same download
/// mechanism as expo-file-system's File.downloadFileAsync (which uses
/// the completion-handler variant). The delegate approach gives us the
/// additional didWriteData callback for progress events.
///
/// The temp file is moved to the destination inside didFinishDownloadingTo,
/// matching how expo-file-system moves it inside the completion handler.
/// iOS deletes the temp file once the callback returns, so the move
/// must happen before then.
private class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate {
  let destinationUrl: URL
  let validateAudio: Bool
  let onProgress: (Int64, Int64) -> Void
  var continuation: CheckedContinuation<Void, Error>?
  var statusCode = 0
  var rejected: String?
  var retryAfterSeconds: Int?

  init(destinationUrl: URL, validateAudio: Bool, onProgress: @escaping (Int64, Int64) -> Void) {
    self.destinationUrl = destinationUrl
    self.validateAudio = validateAudio
    self.onProgress = onProgress
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    onProgress(totalBytesWritten, totalBytesExpectedToWrite)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    let http = downloadTask.response as? HTTPURLResponse
    statusCode = http?.statusCode ?? 200
    guard statusCode >= 200 && statusCode < 300 else {
      if validateAudio {
        rejected = "http"
        if let header = http?.value(forHTTPHeaderField: "Retry-After") {
          retryAfterSeconds = Int(header.trimmingCharacters(in: .whitespaces))
        }
        continuation?.resume(returning: ())
      } else {
        continuation?.resume(throwing: DownloadError.httpError(statusCode))
      }
      continuation = nil
      return
    }

    if validateAudio && Self.looksLikeTextBody(location) {
      rejected = "notAudio"
      continuation?.resume(returning: ())
      continuation = nil
      return
    }

    do {
      if FileManager.default.fileExists(atPath: destinationUrl.path) {
        try FileManager.default.removeItem(at: destinationUrl)
      }
      try FileManager.default.moveItem(at: location, to: destinationUrl)
      continuation?.resume(returning: ())
    } catch {
      continuation?.resume(throwing: error)
    }
    continuation = nil
  }

  /// A Subsonic error body (XML or JSON) starts with `<` or `{` after optional
  /// whitespace / UTF-8 BOM. No audio container starts with either byte.
  static func looksLikeTextBody(_ url: URL) -> Bool {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 64)) ?? Data()
    for byte in head {
      switch byte {
      case 0x20, 0x09, 0x0A, 0x0D, 0xEF, 0xBB, 0xBF: continue
      case 0x3C, 0x7B: return true
      default: return false
      }
    }
    return head.isEmpty
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let error = error else { return }
    if (error as? URLError)?.code == .cancelled {
      continuation?.resume(throwing: DownloadError.cancelled)
    } else {
      continuation?.resume(throwing: error)
    }
    continuation = nil
  }
}

/// Prepared transfers remain registered until their worker exits, even after cancel.
private enum ActiveDownloads {
  final class Transfer {
    var task: URLSessionTask?
    var cancelled = false
  }

  private static let lock = NSLock()
  private static var transfers: [String: Transfer] = [:]

  static func prepare(_ id: String) {
    lock.lock(); defer { lock.unlock() }
    transfers[id] = Transfer()
  }

  static func begin(_ id: String) -> Transfer {
    lock.lock(); defer { lock.unlock() }
    let transfer = transfers[id] ?? Transfer()
    transfers[id] = transfer
    return transfer
  }

  static func attach(_ transfer: Transfer, _ task: URLSessionTask) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if transfer.cancelled { return false }
    transfer.task = task
    return true
  }

  static func remove(_ id: String, _ transfer: Transfer) {
    lock.lock(); defer { lock.unlock() }
    if transfers[id] === transfer { transfers.removeValue(forKey: id) }
  }

  static func cancel(_ id: String) -> Bool {
    lock.lock()
    let transfer = transfers[id]
    transfer?.cancelled = true
    let task = transfer?.task
    lock.unlock()
    task?.cancel()
    return transfer != nil
  }

  static func cancelAll() {
    lock.lock()
    let tasks = transfers.values.compactMap { transfer -> URLSessionTask? in
      transfer.cancelled = true
      return transfer.task
    }
    lock.unlock()
    tasks.forEach { $0.cancel() }
  }
}
