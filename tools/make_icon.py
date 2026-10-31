"""Makes the app's original icon (48x48), CIA banner (256x128) and banner chime.

Usage: python tools/make_icon.py  -> writes icon.png, cia/banner.png and cia/banner.wav.
"""
import math
import struct
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RED, BLUE, NAVY, WHITE = (214, 69, 65), (52, 92, 170), (18, 24, 44), (255, 255, 255)


def font(size):
    for name in ("arialbd.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def badge(size):
    """Rounded square split diagonally red/blue by a white zigzag, with VS on top."""
    s = size * 4  # draw large, then downsample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=255)
    art = Image.new("RGBA", (s, s), BLUE)
    d = ImageDraw.Draw(art)
    zig = [(0, 0), (s * 0.62, 0), (s * 0.46, s * 0.44), (s * 0.58, s * 0.48), (s * 0.30, s), (0, s)]
    d.polygon(zig, fill=RED)
    d.line(zig[1:5], fill=WHITE, width=s // 18, joint="curve")
    f = font(int(s * 0.42))
    d.text((s / 2, s / 2), "VS", font=f, fill=WHITE, anchor="mm", stroke_width=s // 40, stroke_fill=NAVY)
    img.paste(art, (0, 0), mask)
    return img.resize((size, size), Image.LANCZOS)


def banner():
    """256x128 HOME Menu banner for the CIA: the badge plus the app name."""
    out = Image.new("RGBA", (256, 128), (0, 0, 0, 0))
    card = Image.new("RGBA", (256, 128), NAVY)
    ImageDraw.Draw(card).rectangle([0, 104, 256, 128], fill=(30, 40, 70))
    mask = Image.new("L", (256, 128), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 255, 127], radius=18, fill=255)
    out.paste(card, (0, 0), mask)
    out.alpha_composite(badge(80), (14, 14))
    d = ImageDraw.Draw(out)
    d.text((104, 38), "Showdown", font=font(25), fill=WHITE)
    d.text((106, 68), "3DS", font=font(26), fill=(255, 211, 74))
    d.text((128, 116), "Unofficial battle client", font=font(12), fill=(200, 210, 232), anchor="mm")
    return out


def chime(path):
    """A short original two-note chime (16-bit mono WAV) for the banner."""
    rate, notes = 22050, [(660.0, 0.16), (990.0, 0.5)]
    frames = bytearray()
    for freq, dur in notes:
        n = int(rate * dur)
        for i in range(n):
            env = min(1.0, i / 200) * (1 - i / n) ** 2  # quick attack, smooth decay
            v = env * (math.sin(2 * math.pi * freq * i / rate) + 0.3 * math.sin(4 * math.pi * freq * i / rate))
            frames += struct.pack("<h", int(v * 9000))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))


def main():
    badge(48).save(ROOT / "icon.png")
    banner().save(ROOT / "cia" / "banner.png")
    chime(ROOT / "cia" / "banner.wav")
    print("wrote icon.png, cia/banner.png, cia/banner.wav")


if __name__ == "__main__":
    main()
