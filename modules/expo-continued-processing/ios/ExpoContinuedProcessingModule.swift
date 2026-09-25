import BackgroundTasks
import ExpoModulesCore
import Foundation

public class ExpoContinuedProcessingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoContinuedProcessing")

    Events("onExpired")

    Function("isSupported") { () -> Bool in
      if #available(iOS 26.0, *) { return true }
      return false
    }

    Function("isActive") { () -> Bool in
      if #available(iOS 26.0, *) { return TaskHolder.shared.isActive }
      return false
    }

    // Submits the task, or — when one is already running — only raises its
    // total. Must be called from the foreground in response to a user tap.
    // Resolves false when unsupported or when the system refuses the request.
    AsyncFunction("begin") { (title: String, subtitle: String, total: Int) -> Bool in
      guard #available(iOS 26.0, *) else { return false }
      return TaskHolder.shared.begin(title: title, subtitle: subtitle, total: Int64(total)) { [weak self] reason in
        DiagnosticsLog.append(["src": "native", "event": "task.expired", "reason": reason])
        self?.sendEvent("onExpired", ["reason": reason])
      }
    }

    Function("setProgress") { (completed: Int, total: Int, subtitle: String?) in
      guard #available(iOS 26.0, *) else { return }
      TaskHolder.shared.setProgress(completed: Int64(completed), total: Int64(total), subtitle: subtitle)
    }

    Function("end") { (success: Bool) in
      guard #available(iOS 26.0, *) else { return }
      TaskHolder.shared.end(success: success)
    }

    Function("isDiagnosticsEnabled") { () -> Bool in
      return DiagnosticsLog.enabled
    }

    Function("logDiagnostic") { (line: [String: Any]) in
      DiagnosticsLog.append(line)
    }
  }
}

@available(iOS 26.0, *)
private final class TaskHolder {
  static let shared = TaskHolder()

  private let lock = NSLock()
  private var registered = false
  private var task: BGContinuedProcessingTask?
  private var pendingSubmit = false
  private var onExpired: ((String) -> Void)?
  private var title = ""
  private var total: Int64 = 0

  private var identifier: String {
    return (Bundle.main.bundleIdentifier ?? "substreamer") + ".downloads"
  }

  var isActive: Bool {
    lock.lock(); defer { lock.unlock() }
    return task != nil || pendingSubmit
  }

  func begin(title: String, subtitle: String, total: Int64, onExpired: @escaping (String) -> Void) -> Bool {
    lock.lock()
    self.onExpired = onExpired
    if let task = task {
      self.total = max(self.total, total)
      task.progress.totalUnitCount = self.total
      lock.unlock()
      DiagnosticsLog.append(["src": "native", "event": "task.raiseTotal", "total": total])
      return true
    }
    if pendingSubmit {
      self.total = max(self.total, total)
      lock.unlock()
      return true
    }
    self.title = title
    self.total = total
    let needsRegister = !registered
    registered = true
    pendingSubmit = true
    lock.unlock()

    if needsRegister {
      let ok = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { [weak self] task in
        guard let task = task as? BGContinuedProcessingTask else {
          task.setTaskCompleted(success: false)
          return
        }
        self?.started(task)
      }
      if !ok {
        DiagnosticsLog.append(["src": "native", "event": "task.registerFailed"])
        lock.lock(); pendingSubmit = false; lock.unlock()
        return false
      }
    }

    let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
    request.strategy = .fail
    do {
      try BGTaskScheduler.shared.submit(request)
      DiagnosticsLog.append(["src": "native", "event": "task.submitted", "total": total])
      return true
    } catch {
      DiagnosticsLog.append(["src": "native", "event": "task.submitFailed", "error": "\(error)"])
      lock.lock(); pendingSubmit = false; lock.unlock()
      return false
    }
  }

  private func started(_ task: BGContinuedProcessingTask) {
    lock.lock()
    self.task = task
    pendingSubmit = false
    task.progress.totalUnitCount = max(total, 1)
    lock.unlock()
    DiagnosticsLog.append(["src": "native", "event": "task.started"])

    // Runs when the system reclaims the task or the person cancels it from
    // the Live Activity. Stop network work and complete before telling JS.
    task.expirationHandler = { [weak self] in
      NotificationCenter.default.post(name: Notification.Name("ExpoAsyncFsCancelAllDownloads"), object: nil)
      guard let self = self else { return }
      self.lock.lock()
      let current = self.task
      self.task = nil
      let callback = self.onExpired
      self.lock.unlock()
      current?.setTaskCompleted(success: false)
      callback?("expired")
    }
  }

  func setProgress(completed: Int64, total: Int64, subtitle: String?) {
    lock.lock()
    self.total = total
    guard let task = task else { lock.unlock(); return }
    task.progress.totalUnitCount = max(total, 1)
    task.progress.completedUnitCount = min(completed, max(total, 1))
    let title = self.title
    lock.unlock()
    if let subtitle = subtitle { task.updateTitle(title, subtitle: subtitle) }
  }

  func end(success: Bool) {
    lock.lock()
    let current = task
    task = nil
    pendingSubmit = false
    lock.unlock()
    guard let current = current else { return }
    if success { current.progress.completedUnitCount = current.progress.totalUnitCount }
    current.setTaskCompleted(success: success)
    DiagnosticsLog.append(["src": "native", "event": "task.ended", "success": success])
  }
}

/// Append-only JSONL log in Documents, enabled by the Info.plist key
/// `SubstreamerDownloadDiagnostics` (set at prebuild). Readable over USB with
/// `xcrun devicectl device copy from` without foregrounding the app.
enum DiagnosticsLog {
  static let enabled: Bool = Bundle.main.object(forInfoDictionaryKey: "SubstreamerDownloadDiagnostics") as? Bool ?? false

  private static let queue = DispatchQueue(label: "substreamer.download-diagnostics")
  private static let url: URL = {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    return docs.appendingPathComponent("download-diagnostics.jsonl")
  }()

  static func append(_ fields: [String: Any]) {
    guard enabled else { return }
    var line = fields
    if line["ts"] == nil { line["ts"] = Date().timeIntervalSince1970 * 1000 }
    queue.async {
      guard JSONSerialization.isValidJSONObject(line),
            var data = try? JSONSerialization.data(withJSONObject: line) else { return }
      data.append(0x0A)
      let fm = FileManager.default
      if !fm.fileExists(atPath: url.path) {
        fm.createFile(
          atPath: url.path,
          contents: nil,
          attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
      }
      guard let handle = try? FileHandle(forWritingTo: url) else { return }
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: data)
    }
  }
}
