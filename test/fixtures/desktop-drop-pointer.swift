import CoreGraphics
import Foundation

guard CGPreflightPostEventAccess() else {
    fputs("Mouse event injection requires macOS Accessibility permission.\n", stderr)
    exit(1)
}
let numbers = CommandLine.arguments.dropFirst().compactMap(Double.init)
guard numbers.count == 4 else { exit(2) }

let original = CGEvent(source: nil)?.location
let source = CGEventSource(stateID: .hidSystemState)
let start = CGPoint(x: numbers[0], y: numbers[1])
let finish = CGPoint(x: numbers[2], y: numbers[3])

func post(_ kind: CGEventType, _ point: CGPoint) {
    guard CGWarpMouseCursorPosition(point) == .success else { exit(4) }
    guard let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: .left) else { exit(3) }
    if kind != .mouseMoved {
        event.setIntegerValueField(.mouseEventNumber, value: 1)
        event.setIntegerValueField(.mouseEventClickState, value: 1)
    }
    event.post(tap: .cghidEventTap)
}

post(.mouseMoved, start)
Thread.sleep(forTimeInterval: 0.3)
post(.leftMouseDown, start)
Thread.sleep(forTimeInterval: 0.3)
for step in 1...40 {
    let progress = Double(step) / 40
    post(.leftMouseDragged, CGPoint(
        x: start.x + (finish.x - start.x) * progress,
        y: start.y + (finish.y - start.y) * progress
    ))
    Thread.sleep(forTimeInterval: 0.02)
}
// Let the native target re-evaluate both the hit region and advertised drop effect.
for offset in [3.0, 0.0, 3.0, 0.0] {
    post(.leftMouseDragged, CGPoint(x: finish.x + offset, y: finish.y))
    Thread.sleep(forTimeInterval: 0.08)
}
post(.leftMouseUp, finish)
Thread.sleep(forTimeInterval: 0.8)
if let original { post(.mouseMoved, original) }
