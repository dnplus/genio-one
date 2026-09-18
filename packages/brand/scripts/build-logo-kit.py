#!/usr/bin/env python3
"""Derive reusable lockups from the original outlined artwork; no font dependency."""
from copy import deepcopy
from pathlib import Path
import base64
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
def tag(name):
    return f"{{{NS}}}{name}"

SOURCE = ET.parse(ROOT / "assets/logo-02.svg").getroot()
WORDMARK = SOURCE.find(tag("g"))
SYMBOL = [node for node in SOURCE if node.tag in (tag("path"), tag("polygon"))]
# Original artwork coordinates. Transforms scale uniformly and retain path data.
ICON_BOUNDS = (31.18, 38.22, 310.12, 251.69)
WORD_BOUNDS = (37.26, 334.10, 336.80, 55.25)
STYLES = {
    "color-light": ("#000000", None),
    "color-dark": ("#ffffff", None),
    "mono-black": ("#000000", "#000000"),
    "mono-white": ("#ffffff", "#ffffff"),
}
LAYOUTS = {
    "horizontal": (282, 80),
    "stacked": (416.32, 412.51),
    "icon": (80, 80),
    "wordmark": (353, 72),
}

def transform(bounds, height, x, y):
    bx, by, _, bh = bounds
    scale = height / bh
    return f"matrix({scale:.8f} 0 0 {scale:.8f} {x-bx*scale:.8f} {y-by*scale:.8f})"

def recolor(node, neutral, mono, prefix):
    for child in node.iter():
        cls = child.attrib.pop("class", None)
        if child.tag in (tag("path"), tag("polygon"), tag("rect")):
            child.set("fill", mono or {
                "st1": "#425fea", "st2": f"url(#{prefix}-trail-low)",
                "st0": f"url(#{prefix}-trail-high)",
            }.get(cls, neutral))
    return node

def build(layout, style):
    width, height = LAYOUTS[layout]
    neutral, mono = STYLES[style]
    prefix = f"genioone-{layout}-{style}"
    svg = ET.Element(tag("svg"), {"viewBox": f"0 0 {width} {height}", "role": "img", "aria-labelledby": f"{prefix}-title"})
    ET.SubElement(svg, tag("title"), {"id": f"{prefix}-title"}).text = "GenioOne"
    if not mono and layout != "wordmark":
        defs = ET.SubElement(svg, tag("defs"))
        for suffix, source_id in (("trail-low", "linear-gradient"), ("trail-high", "linear-gradient1")):
            gradient = deepcopy(SOURCE.find(f".//{tag('linearGradient')}[@id='{source_id}']"))
            gradient.set("id", f"{prefix}-{suffix}")
            defs.append(gradient)
    if layout != "wordmark":
        symbol = ET.SubElement(svg, tag("g"), {"id": f"{prefix}-symbol"})
        for node in SYMBOL:
            symbol.append(recolor(deepcopy(node), neutral, mono, prefix))
        if layout == "horizontal":
            symbol.set("transform", transform(ICON_BOUNDS, 64, 8, 8))
        elif layout == "icon":
            icon_height = ICON_BOUNDS[3] * 64 / ICON_BOUNDS[2]
            symbol.set("transform", transform(ICON_BOUNDS, icon_height, 8, (80-icon_height)/2))
    if layout != "icon":
        word = recolor(deepcopy(WORDMARK), neutral, mono, prefix)
        word.set("id", f"{prefix}-wordmark")
        if layout == "horizontal":
            icon_width = ICON_BOUNDS[2] * 64 / ICON_BOUNDS[3]
            word.set("transform", transform(WORD_BOUNDS, 28, 8 + icon_width + 16, 26))
        elif layout == "wordmark":
            word.set("transform", transform(WORD_BOUNDS, 55.25, 8, (72-55.25)/2))
        svg.append(word)
    ET.indent(svg, space="  ")
    return ET.tostring(svg, encoding="unicode") + "\n"

def main():
    target = ROOT / "assets/logos"
    target.mkdir(parents=True, exist_ok=True)
    manifest = []
    for layout in LAYOUTS:
        for style in STYLES:
            name = f"genioone-{layout}-{style}.svg"
            (target / name).write_text(build(layout, style))
            manifest.append({"file": name, "layout": layout, "style": style, "viewBox": [0, 0, *LAYOUTS[layout]]})
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    layout_names = {"horizontal": "橫式標準版", "stacked": "直式原版", "icon": "純圖示", "wordmark": "純字標"}
    style_names = {"color-light": "淺底彩色", "color-dark": "深底彩色", "mono-black": "單色黑", "mono-white": "單色白"}
    rows = []
    for layout in LAYOUTS:
        cards = []
        for entry in [item for item in manifest if item["layout"] == layout]:
            data = base64.b64encode((target / entry['file']).read_bytes()).decode()
            dark = entry['style'] in ('color-dark', 'mono-white')
            cards.append(f'<article><div class="art {"dark" if dark else ""}"><img class="{layout}" src="data:image/svg+xml;base64,{data}" alt="GenioOne {layout_names[layout]} {style_names[entry["style"]]}"></div><p>{style_names[entry["style"]]}</p><a download="{entry["file"]}" href="data:image/svg+xml;base64,{data}">下載 SVG</a></article>')
        rows.append(f'<section><h2>{layout_names[layout]}</h2><div class="grid">{"".join(cards)}</div></section>')
    (ROOT / 'logo-preview.html').write_text('''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GenioOne · Logo 素材</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#111;font:14px/1.6 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:32px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 12px}p{margin:8px 0}header{border-top:4px solid #425fea;padding-top:20px}.muted{color:#6b7280}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}article{min-width:0;border:1px solid #d9dee7;border-radius:8px;overflow:hidden;background:white;padding-bottom:12px}article p,article a{margin:8px 12px}a{color:#425fea}.art{height:164px;display:flex;justify-content:center;align-items:center;background:#fff;padding:12px}.art.dark{background:#1f1f1f}img{display:block;max-width:100%;object-fit:contain}.horizontal{width:248px}.stacked{height:140px}.icon{height:80px}.wordmark{width:240px}footer{margin-top:28px;border-top:1px solid #d9dee7;padding-top:16px}@media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:16px}}@media(max-width:420px){.grid{grid-template-columns:1fr}}</style><main><header><h1>GenioOne Logo 素材</h1><p>4 種版型 × 4 種配色，共 16 個透明背景 SVG。圖形與字標沿用原始向量輪廓。</p><p class="muted">淺底／深底指使用情境；預覽底色不包含在 SVG 內。純圖示適合收合側欄，橫式適合頁首與文件。</p></header>''' + ''.join(rows) + '''<footer><p>橫式建議寬度至少 160px，直式至少 96px，字標至少 120px，圖示建議 24px 以上。16px 圖示的漸層細節較弱，優先選單色版。</p><p class="muted">素材含內建留白；使用時維持長寬比例，周圍另留至少圖示高度 1/4 的空間。字標皆為 path，不需要安裝字型。可直接下載 SVG，本頁可離線分享。</p></footer></main></html>''')
    print(f"Generated {len(manifest)} SVG assets in {target}")

if __name__ == "__main__":
    main()
