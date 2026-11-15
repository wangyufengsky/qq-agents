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
// Only a uniquely matched physical display can provide a safe Dock exclusion.
func dockSafeBounds(_ bounds: CGRect) -> CGRect? {
    let screens = NSScreen.screens
    guard let primary = screens.first, primary.frame.origin == .zero else { return nil }
    var matches: [CGRect] = []
    var ids = Set<CGDirectDisplayID>()
    for screen in screens {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let id = CGDirectDisplayID(number.uint32Value)
        guard ids.insert(id).inserted else { return nil }
        let frame = screen.frame
        let cg = CGDisplayBounds(id)
        let converted = CGRect(x: frame.minX, y: primary.frame.maxY - frame.maxY, width: frame.width, height: frame.height)
        guard converted == cg else { return nil }
        if cg == bounds {
            let visible = screen.visibleFrame
            guard frame.contains(visible), visible.width > 0, visible.height > 0 else { return nil }
            matches.append(CGRect(x: cg.minX + visible.minX - frame.minX,
                                  y: cg.minY + frame.maxY - visible.maxY,
                                  width: visible.width, height: visible.height))
        }
    }
    return matches.count == 1 ? matches[0] : nil
}

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
    var entry: [String: Any] = [
        "id": "w-\(id)", "pid": pid, "layer": layer,
        "owner": owner, "name": name, "bundle": app?.bundleIdentifier ?? "",
        "bounds": ["x": bounds.origin.x, "y": bounds.origin.y,
                   "width": bounds.width, "height": bounds.height]
    ]
    // The process owner and application name are localized.
    if app?.bundleIdentifier == "com.apple.dock",
       app?.executableURL?.standardizedFileURL.resolvingSymlinksInPath().path == "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock",
       row[kCGWindowName as String] as? String == "Dock",
       layer == Int(CGWindowLevelForKey(.dockWindow)),
       let safe = dockSafeBounds(bounds) {
        entry["dockSafeBounds"] = ["x": safe.origin.x, "y": safe.origin.y,
                                   "width": safe.width, "height": safe.height]
    }
    windows.append(entry)
}
guard let data = try? JSONSerialization.data(withJSONObject: [
    "complete": true, "foregroundPid": foreground.processIdentifier, "windows": windows
]), let result = String(data: data, encoding: .utf8) else { unavailable() }
print(result)
