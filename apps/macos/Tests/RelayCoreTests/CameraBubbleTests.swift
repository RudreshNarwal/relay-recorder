import CoreGraphics
import Testing
@testable import RelayCore

@Test func cameraBubbleCornersStayInsideTheFrameAndRoundTripDrags() {
    let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080), side = CameraBubble.side(in: bounds), margin = CameraBubble.margin(in: bounds)
    let rects = Dictionary(uniqueKeysWithValues: CameraCorner.allCases.map { ($0, CameraBubble.frame(position: $0.position, in: bounds)) })
    #expect(rects[.bottomLeft] == CGRect(x: margin, y: margin, width: side, height: side))
    #expect(rects[.topRight] == CGRect(x: bounds.width - margin - side, y: bounds.height - margin - side, width: side, height: side))
    for (corner, rect) in rects {
        #expect(bounds.contains(rect))
        #expect(CameraBubble.position(of: rect, in: bounds) == corner.position)
    }
    // A screen-space panel (offset bounds, points) maps to the same normalized spot as the recorded frame.
    let screen = CGRect(x: 100, y: 50, width: 1512, height: 850), dragged = CameraBubble.frame(position: CGPoint(x: 0.3, y: 0.7), in: screen)
    let p = CameraBubble.position(of: dragged, in: screen)
    #expect(abs(p.x - 0.3) < 0.001 && abs(p.y - 0.7) < 0.001)
    #expect(CameraShape.circle.cornerFraction == 0.5)
}
