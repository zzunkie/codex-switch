import AppKit
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let assets = URL(fileURLWithPath: CommandLine.arguments[2])
let iconset = destination.appendingPathComponent("AppIcon.iconset")
guard let source = NSImage(contentsOf: assets.appendingPathComponent("BrandIcon.png")) else { fatalError("BrandIcon.png is required") }
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
// Package the generated artwork at Apple's required icon sizes; preserve alpha.
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context; context.imageInterpolation = .high
        source.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 1 ? "" : "@2x"
        try bitmap.representation(using: .png, properties: [:])!.write(to: iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil"); p.arguments = ["-c","icns",iconset.path,"-o",destination.appendingPathComponent("AppIcon.icns").path]; try p.run(); p.waitUntilExit()
guard p.terminationStatus == 0 else { fatalError("iconutil failed") }
try FileManager.default.removeItem(at: iconset)
