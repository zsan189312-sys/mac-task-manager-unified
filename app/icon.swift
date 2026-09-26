// 程序化绘制 macOS 风格图标（整合版）：深色渐变圆角方块 + 顶部双机指示点（本机蓝 / 远程紫）+ 上升柱状图 + 趋势线
import AppKit

let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
guard let ctx = NSGraphicsContext.current?.cgContext else { exit(1) }

// ---- 阴影 + 深色渐变底（Big Sur 圆角方块：824/1024，圆角 184）----
let frame = NSRect(x: 100, y: 100, width: 824, height: 824)
let squircle = NSBezierPath(roundedRect: frame, xRadius: 184, yRadius: 184)

ctx.saveGState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.30)
shadow.shadowBlurRadius = 36
shadow.shadowOffset = NSSize(width: 0, height: -22)
shadow.set()
ctx.setFillColor(NSColor.black.cgColor)
ctx.addPath(squircle.cgPath)
ctx.fillPath()
ctx.restoreGState()

// 底色渐变：紫黑（与本机版蓝黑、N100 版青黑区分）
let bg = NSGradient(colors: [
    NSColor(srgbRed: 0.165, green: 0.129, blue: 0.235, alpha: 1),
    NSColor(srgbRed: 0.055, green: 0.051, blue: 0.098, alpha: 1)
])!
bg.draw(in: squircle, angle: -90)

// 顶部内侧高光（玻璃质感）
ctx.saveGState()
squircle.addClip()
let hi = NSGradient(colors: [
    NSColor.white.withAlphaComponent(0.10),
    NSColor.white.withAlphaComponent(0.0)
])!
hi.draw(in: NSRect(x: 100, y: 624, width: 824, height: 300), angle: -90)
ctx.restoreGState()

// 1px 内描边（细腻轮廓）
ctx.saveGState()
squircle.addClip()
squircle.lineWidth = 3
NSColor.white.withAlphaComponent(0.08).setStroke()
squircle.stroke()
ctx.restoreGState()

// ---- 顶部双机指示点：蓝（本机 Mac）+ 紫（远程主机），中间连线表示联动 ----
ctx.saveGState()
let link = NSBezierPath()
link.lineWidth = 10
link.lineCapStyle = .round
link.move(to: NSPoint(x: 448, y: 762))
link.line(to: NSPoint(x: 576, y: 762))
NSColor.white.withAlphaComponent(0.35).setStroke()
link.stroke()

let d1 = NSBezierPath(ovalIn: NSRect(x: 376, y: 726, width: 72, height: 72))
NSColor(srgbRed: 0.10, green: 0.55, blue: 1.0, alpha: 1).setFill()
d1.fill()
let d2 = NSBezierPath(ovalIn: NSRect(x: 576, y: 726, width: 72, height: 72))
NSColor(srgbRed: 0.75, green: 0.35, blue: 0.95, alpha: 1).setFill()
d2.fill()
ctx.restoreGState()

// ---- 柱状图：4 根上升圆角柱（紫→蓝紫→蓝→青）----
let colors: [NSColor] = [
    NSColor(srgbRed: 0.75, green: 0.35, blue: 0.95, alpha: 1),   // BF5AF2 紫
    NSColor(srgbRed: 0.49, green: 0.35, blue: 0.98, alpha: 1),    // 蓝紫
    NSColor(srgbRed: 0.18, green: 0.55, blue: 1.0, alpha: 1),     // 0A84FF 蓝
    NSColor(srgbRed: 0.39, green: 0.82, blue: 1.0, alpha: 1)      // 64D2FF 青
]
let barW: CGFloat = 74
let gap: CGFloat = 22
let heights: [CGFloat] = [150, 218, 286, 354]
let baseY: CGFloat = 300
for (i, h) in heights.enumerated() {
    let x = 272 + CGFloat(i) * (barW + gap)
    let rect = NSRect(x: x, y: baseY, width: barW, height: h)
    let bar = NSBezierPath(roundedRect: rect, xRadius: 26, yRadius: 26)
    let g = NSGradient(colors: [
        colors[i].blended(withFraction: 0.25, of: .white)!,
        colors[i]
    ])!
    g.draw(in: bar, angle: -90)
    // 柱顶柔光
    ctx.saveGState()
    bar.addClip()
    let g2 = NSGradient(colors: [.white.withAlphaComponent(0.28), .white.withAlphaComponent(0.0)])!
    g2.draw(in: NSRect(x: x, y: baseY + h - 40, width: barW, height: 40), angle: -90)
    ctx.restoreGState()
}

// ---- 趋势线：白色细线爬升 + 末端亮点 ----
ctx.saveGState()
let line = NSBezierPath()
line.lineWidth = 14
line.lineCapStyle = .round
line.lineJoinStyle = .round
line.move(to: NSPoint(x: 276, y: 470))
line.curve(to: NSPoint(x: 452, y: 548), controlPoint1: NSPoint(x: 352, y: 470), controlPoint2: NSPoint(x: 400, y: 540))
line.curve(to: NSPoint(x: 610, y: 505), controlPoint1: NSPoint(x: 505, y: 556), controlPoint2: NSPoint(x: 560, y: 530))
line.curve(to: NSPoint(x: 752, y: 600), controlPoint1: NSPoint(x: 668, y: 480), controlPoint2: NSPoint(x: 716, y: 560))
NSColor.white.withAlphaComponent(0.92).setStroke()
line.stroke()
// 末端光点
let dot = NSBezierPath(ovalIn: NSRect(x: 752 - 26, y: 600 - 26, width: 52, height: 52))
NSColor.white.withAlphaComponent(0.25).setFill()
dot.fill()
let dot2 = NSBezierPath(ovalIn: NSRect(x: 752 - 13, y: 600 - 13, width: 26, height: 26))
NSColor.white.setFill()
dot2.fill()
ctx.restoreGState()

img.unlockFocus()

// ---- 写出 PNG（透明底）----
guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"))
print("icon written")
