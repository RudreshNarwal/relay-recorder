import CoreGraphics

public enum CameraShape: String, CaseIterable, Identifiable, Sendable {
    case circle = "Circle", rounded = "Rounded", square = "Square"
    public var id: String { rawValue }
    /// Corner radius as a fraction of the bubble side.
    public var cornerFraction: CGFloat {
        switch self { case .circle: 0.5; case .rounded: 0.2; case .square: 0.04 }
    }
}

public enum CameraCorner: String, CaseIterable, Identifiable, Sendable {
    case bottomRight = "Bottom right", bottomLeft = "Bottom left", topRight = "Top right", topLeft = "Top left"
    public var id: String { rawValue }
    /// Normalized position in y-up coordinates (AppKit and Core Image).
    public var position: CGPoint {
        switch self {
        case .bottomRight: CGPoint(x: 1, y: 0)
        case .bottomLeft: CGPoint(x: 0, y: 0)
        case .topRight: CGPoint(x: 1, y: 1)
        case .topLeft: CGPoint(x: 0, y: 1)
        }
    }
}

/// One geometry for the floating bubble and the recorded frame, so what you see is what is recorded.
public enum CameraBubble {
    public static func side(in bounds: CGRect) -> CGFloat { (min(bounds.width, bounds.height) * 0.25).rounded() }
    public static func margin(in bounds: CGRect) -> CGFloat { (min(bounds.width, bounds.height) * 0.03).rounded() }
    public static func frame(position: CGPoint, in bounds: CGRect) -> CGRect {
        let side = side(in: bounds), margin = margin(in: bounds)
        let x = bounds.minX + margin + max(0, min(1, position.x)) * max(0, bounds.width - side - 2 * margin)
        let y = bounds.minY + margin + max(0, min(1, position.y)) * max(0, bounds.height - side - 2 * margin)
        return CGRect(x: x, y: y, width: side, height: side)
    }
    /// Inverse of `frame`, for a bubble the user dragged.
    public static func position(of frame: CGRect, in bounds: CGRect) -> CGPoint {
        let margin = margin(in: bounds)
        let travelX = max(1, bounds.width - frame.width - 2 * margin), travelY = max(1, bounds.height - frame.height - 2 * margin)
        return CGPoint(x: max(0, min(1, (frame.minX - bounds.minX - margin) / travelX)), y: max(0, min(1, (frame.minY - bounds.minY - margin) / travelY)))
    }
}
