"""Build the GitHub social preview (1280x640) from the screenshot.

The source screenshot is 1602x1028 (about 1.56:1), so fitting it to 1280 wide
leaves 821px of height: a gentle centre crop removes 181px instead of
letterboxing, keeping essentially the whole UI visible.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "screenshot.png"
OUT = ROOT / "docs" / "social-preview.png"

TARGET_W, TARGET_H = 1280, 640

image = Image.open(SRC).convert("RGB")
w, h = image.size
# Scale to the target width, then centre-crop the surplus height.
scale = TARGET_W / w
resized = image.resize((TARGET_W, round(h * scale)), Image.LANCZOS)
top = max(0, (resized.height - TARGET_H) // 2)
card = resized.crop((0, top, TARGET_W, top + TARGET_H))

draw = ImageDraw.Draw(card)
font = None
for candidate in (
    "segoeuib.ttf",
    "Segoe UI Bold",
    "arialbd.ttf",
    "DejaVuSans-Bold.ttf",
):
    try:
        font = ImageFont.truetype(candidate, 34)
        break
    except OSError:
        continue
if font is None:
    font = ImageFont.load_default()

title = "dsh-session-manager"
subtitle = "Manage and permanently delete archived DSH sessions"

# A translucent bar keeps the text readable over any screenshot content.
bar_h = 96
draw.rectangle((0, TARGET_H - bar_h, TARGET_W, TARGET_H), fill=(12, 14, 18))
bar = Image.new("RGBA", (TARGET_W, bar_h), (12, 14, 18, 225))
card.paste(bar, (0, TARGET_H - bar_h), bar)
draw.rectangle((0, TARGET_H - bar_h, TARGET_W, TARGET_H - bar_h + 2), fill=(224, 145, 42))

draw.text((40, TARGET_H - bar_h + 18), title, font=font, fill=(255, 255, 255))
draw.text((40, TARGET_H - bar_h + 58), subtitle, font=font.font_variant(size=20) if hasattr(font, "font_variant") else font, fill=(198, 205, 214))

OUT.parent.mkdir(parents=True, exist_ok=True)
card.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT.relative_to(ROOT)} {card.size[0]}x{card.size[1]} {OUT.stat().st_size} bytes")
