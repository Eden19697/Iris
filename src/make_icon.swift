import Cocoa

let S: CGFloat = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

func rgb(_ h: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((h >> 16) & 255) / 255, green: CGFloat((h >> 8) & 255) / 255, blue: CGFloat(h & 255) / 255, alpha: a)
}

// 圆角方块底板(macOS 图标规格:824 内容区,留白给阴影)
let box = NSRect(x: 100, y: 100, width: 824, height: 824)
let base = NSBezierPath(roundedRect: box, xRadius: 184, yRadius: 184)
ctx.saveGState()
let sh = NSShadow(); sh.shadowColor = rgb(0x3b2a20, 0.28); sh.shadowBlurRadius = 28; sh.shadowOffset = NSSize(width: 0, height: -12)
sh.set()
rgb(0xfaf9f5).setFill(); base.fill()
ctx.restoreGState()

ctx.saveGState()
base.addClip()
NSGradient(colors: [rgb(0xfdfcf8), rgb(0xf0eee6)])!.draw(in: box, angle: -70)

// 花瓣:从中心向外的水滴形
func petal(length l: CGFloat, width w: CGFloat) -> NSBezierPath {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: 0, y: 0))
    p.curve(to: NSPoint(x: 0, y: l), controlPoint1: NSPoint(x: w * 1.15, y: l * 0.28), controlPoint2: NSPoint(x: w * 0.5, y: l))
    p.curve(to: NSPoint(x: 0, y: 0), controlPoint1: NSPoint(x: -w * 0.5, y: l), controlPoint2: NSPoint(x: -w * 1.15, y: l * 0.28))
    p.close()
    return p
}
func layer(count: Int, offset: CGFloat, length: CGFloat, width: CGFloat, color: NSColor, veins: Bool) {
    for i in 0..<count {
        ctx.saveGState()
        ctx.translateBy(x: 512, y: 512)
        ctx.rotate(by: offset + CGFloat(i) * 2 * .pi / CGFloat(count))
        color.setFill(); petal(length: length, width: width).fill()
        if veins {
            let v = NSBezierPath(); v.move(to: NSPoint(x: 0, y: length * 0.2)); v.line(to: NSPoint(x: 0, y: length * 0.74))
            v.lineWidth = 7; v.lineCapStyle = .round
            rgb(0xfaf9f5, 0.55).setStroke(); v.stroke()
        }
        ctx.restoreGState()
    }
}
layer(count: 8, offset: .pi / 8, length: 330, width: 112, color: rgb(0xeab29a), veins: false)   // 后层:浅杏色
layer(count: 8, offset: 0,       length: 290, width: 100, color: rgb(0xd97757), veins: false)   // 前层:陶土橘
layer(count: 8, offset: 0,       length: 290, width: 100, color: rgb(0xc6613f, 0.0), veins: true) // 叶脉线

// 花心
rgb(0xc6613f).setFill(); NSBezierPath(ovalIn: NSRect(x: 512 - 62, y: 512 - 62, width: 124, height: 124)).fill()
rgb(0xfaf9f5).setFill();  NSBezierPath(ovalIn: NSRect(x: 512 - 40, y: 512 - 40, width: 80, height: 80)).fill()
rgb(0xd97757).setFill();  NSBezierPath(ovalIn: NSRect(x: 512 - 15, y: 512 - 15, width: 30, height: 30)).fill()
ctx.restoreGState()

// 细高光描边
rgb(0xffffff, 0.6).setStroke(); base.lineWidth = 2; base.stroke()
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
