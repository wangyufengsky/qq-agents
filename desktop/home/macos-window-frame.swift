import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

@available(macOS 14.2, *)
@MainActor
func writeWindowFrame(_ args: [String]) async {
    guard args.count == 4,
          let id = CGWindowID(args[0]), id > 0,
          let pid = pid_t(args[1]), pid > 0,
          let maxEdge = Int(args[2]), (1...4096).contains(maxEdge),
          let maxBytes = Int(args[3]), (1...44 * 1024).contains(maxBytes)
    else { return }
    guard CGPreflightScreenCaptureAccess() else { exit(2) }
    // The window-only filter queries display geometry through AppKit's WindowServer connection.
    _ = NSApplication.shared
    guard NSScreen.main != nil,
          let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true),
          let window = content.windows.first(where: { $0.windowID == id }),
          window.isOnScreen, window.owningApplication?.processID == pid
    else { return }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let width = filter.contentRect.width * CGFloat(filter.pointPixelScale)
    let height = filter.contentRect.height * CGFloat(filter.pointPixelScale)
    guard width.isFinite, height.isFinite, width > 0, height > 0 else { return }
    let scale = min(1, CGFloat(maxEdge) / max(width, height))
    let config = SCStreamConfiguration()
    config.width = max(1, Int((width * scale).rounded()))
    config.height = max(1, Int((height * scale).rounded()))
    config.ignoreShadowsSingleWindow = true
    config.includeChildWindows = false
    config.showsCursor = false
    guard let frame = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    else { return }

    guard max(frame.width, frame.height) <= maxEdge,
          let rgb = CGColorSpace(name: CGColorSpace.sRGB) else { return }
    for scale in [1.0, 0.75, 0.5, 0.25] {
        // Resample the same frame if JPEG quality alone cannot fit the request budget.
        let width = max(1, Int((Double(frame.width) * scale).rounded()))
        let height = max(1, Int((Double(frame.height) * scale).rounded()))
        guard let canvas = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                     bytesPerRow: 0, space: rgb,
                                     bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return }
        canvas.draw(frame, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = canvas.makeImage() else { return }
        let bitmap = NSBitmapImageRep(cgImage: image)
        for quality in [0.85, 0.65, 0.45, 0.25] {
            if let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]),
               jpeg.count <= maxBytes {
                FileHandle.standardOutput.write(jpeg)
                return
            }
        }
    }
}

if #available(macOS 14.2, *) {
    await writeWindowFrame(Array(CommandLine.arguments.dropFirst()))
}
