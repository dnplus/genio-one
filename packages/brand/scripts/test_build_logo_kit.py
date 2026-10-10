"""Validate generated logo contracts without regenerating repository assets."""
import importlib.util
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location(
    "build_logo_kit", Path(__file__).with_name("build-logo-kit.py")
)
kit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kit)


class LogoKitTests(unittest.TestCase):
    def variants(self):
        for layout in kit.LAYOUTS:
            for style in kit.STYLES:
                yield layout, style, ET.fromstring(kit.build(layout, style))

    def test_variants_have_accessible_titles_and_documented_dimensions(self):
        dimensions = {
            "horizontal": [0, 0, 282, 80],
            "stacked": [0, 0, 416.32, 412.51],
            "icon": [0, 0, 80, 80],
            "wordmark": [0, 0, 353, 72],
        }
        variants = list(self.variants())
        self.assertEqual(len(variants), 16)
        for layout, style, svg in variants:
            with self.subTest(layout=layout, style=style):
                self.assertEqual(svg.tag, kit.tag("svg"))
                self.assertEqual(list(map(float, svg.attrib["viewBox"].split())), dimensions[layout])
                self.assertEqual(svg.attrib["role"], "img")
                title = svg.find(kit.tag("title"))
                self.assertIsNotNone(title)
                self.assertEqual(title.text, "GenioOne")
                self.assertEqual(svg.attrib["aria-labelledby"], title.attrib["id"])
                self.assertEqual(len(svg.findall(f".//{kit.tag('text')}")), 0)
                self.assertTrue(svg.findall(f".//{kit.tag('path')}"))

    def test_references_resolve_locally_and_variants_have_disjoint_ids(self):
        used_ids = set()
        for layout, style, svg in self.variants():
            with self.subTest(layout=layout, style=style):
                ids = [node.attrib["id"] for node in svg.iter() if "id" in node.attrib]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertTrue(used_ids.isdisjoint(ids))
                used_ids.update(ids)
                references = []
                for node in svg.iter():
                    for value in node.attrib.values():
                        references.extend(re.findall(r"url\(#([^)]*)\)", value))
                self.assertTrue(set(references).issubset(ids))
                gradients = svg.findall(f".//{kit.tag('linearGradient')}")
                if style.startswith("color-") and layout != "wordmark":
                    self.assertEqual(len(gradients), 2)
                    self.assertEqual(set(references), {node.attrib["id"] for node in gradients})
                else:
                    self.assertEqual(gradients, [])
                    self.assertEqual(references, [])

    def test_monochrome_artwork_uses_only_the_selected_solid_fill(self):
        for layout, style, svg in self.variants():
            if not style.startswith("mono-"):
                continue
            with self.subTest(layout=layout, style=style):
                expected = "#000000" if style == "mono-black" else "#ffffff"
                shapes = [node for node in svg.iter() if node.tag in {kit.tag("path"), kit.tag("polygon"), kit.tag("rect")}]
                self.assertTrue(shapes)
                self.assertEqual({node.attrib.get("fill") for node in shapes}, {expected})
                self.assertFalse(any("class" in node.attrib for node in svg.iter()))

    def test_build_is_repeatable_and_does_not_mutate_source_artwork(self):
        source_before = ET.tostring(kit.SOURCE)
        variants = [(layout, style) for layout in kit.LAYOUTS for style in kit.STYLES]
        first = {(layout, style): kit.build(layout, style) for layout, style in variants}
        for layout, style in reversed(variants):
            with self.subTest(layout=layout, style=style):
                self.assertEqual(kit.build(layout, style), first[layout, style])
                self.assertEqual(ET.tostring(kit.SOURCE), source_before)


if __name__ == "__main__":
    unittest.main()
