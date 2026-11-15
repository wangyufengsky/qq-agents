import AppKit
import CoreGraphics
import Foundation

func unavailable() -> Never {
    print("{\"complete\":false}")
    exit(0)
}

guard CGPreflightScreenCaptureAccess(),
      let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]],
      let foreground = NSWorkspace.shared.frontmostApplication,
      foreground.processIdentifier > 0 else { unavailable() }
var windows: [[String: Any]] = []
for row in rows {
    guard let id = row[kCGWindowNumber as String] as? Int, id > 0,
          let pid = row[kCGWindowOwnerPID as String] as? Int, pid > 0,
          let layer = row[kCGWindowLayer as String] as? Int,
          let rawBounds = row[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
          bounds.origin.x.isFinite, bounds.origin.y.isFinite,
          bounds.width.isFinite, bounds.height.isFinite,
          bounds.width > 0, bounds.height > 0,
          let owner = row[kCGWindowOwnerName as String] as? String, !owner.isEmpty else { unavailable() }
    let app = NSRunningApplication(processIdentifier: pid_t(pid))
    let name = app?.localizedName ?? owner
    windows.append([
        "id": "w-\(id)", "pid": pid, "layer": layer,
        "owner": owner, "name": name, "bundle": app?.bundleIdentifier ?? "",
        "bounds": ["x": bounds.origin.x, "y": bounds.origin.y,
                   "width": bounds.width, "height": bounds.height]
    ])
}
guard let data = try? JSONSerialization.data(withJSONObject: [
    "complete": true, "foregroundPid": foreground.processIdentifier, "windows": windows
]), let result = String(data: data, encoding: .utf8) else { unavailable() }
print(result)
