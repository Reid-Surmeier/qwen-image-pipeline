"""Preserved deterministic typesetting kernel; application supplies fonts and layouts."""
from __future__ import annotations
import hashlib, re
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower().replace("’", "'").replace("–", "-"))


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size)


def line_width(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont) -> int:
    box = draw.textbbox((0, 0), text, font=face)
    return box[2] - box[0]


def wrap(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont, width: int) -> list[str]:
    if "\n" in text:
        lines: list[str] = []
        for part in text.splitlines():
            lines.extend(wrap(draw, part, face, width) if part else [""])
        return lines
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and line_width(draw, candidate, face) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def make_erase_mask(image: np.ndarray, blocks: list[dict]) -> np.ndarray:
    mask = np.zeros(image.shape[:2], dtype=np.uint8)
    for block in blocks:
        x, y, width, height = block["box"]
        crop = image[y:y + height, x:x + width]
        gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
        hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
        ink = ((gray < 225) | (hsv[:, :, 1] > 35)).astype(np.uint8) * 255
        ink = cv2.dilate(ink, np.ones((11, 11), np.uint8), iterations=1)
        mask[y:y + height, x:x + width] = np.maximum(mask[y:y + height, x:x + width], ink)
    return mask


def make_region_mask(image: np.ndarray, blocks: list[dict]) -> np.ndarray:
    mask = np.zeros(image.shape[:2], dtype=np.uint8)
    for block in blocks:
        x, y, width, height = block["box"]
        mask[y:y + height, x:x + width] = 255
    return mask


def synthesize_scan_background(image: np.ndarray, regions: list[dict]) -> np.ndarray:
    """Clear complete legacy lockups without leaving Telea logo smears.

    Each replacement row is derived from the light, low-saturation paper pixels
    on that same source scanline. A fixed noise field retains the scanned-paper
    character while keeping the operation replayable.
    """
    result = image.copy()
    rng = np.random.default_rng(35)
    full_gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    full_hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    for region in regions:
        x, y, width, height = region["box"]
        rows = np.empty((height, 1, 3), dtype=np.float32)
        for offset, source_y in enumerate(range(y, y + height)):
            valid = (full_gray[source_y] > 212) & (full_hsv[source_y, :, 1] < 48)
            pixels = image[source_y, valid]
            rows[offset, 0] = np.median(pixels, axis=0) if len(pixels) else [245, 245, 245]
        paper = np.repeat(rows, width, axis=1)
        paper += rng.normal(0, 0.75, paper.shape)
        result[y:y + height, x:x + width] = np.clip(paper, 0, 255).astype(np.uint8)
    return result


def draw_block(draw: ImageDraw.ImageDraw, block: dict, fonts: dict) -> dict:
    x, y, width, height = block["box"]
    padding = block.get("padding", 20)
    inner_x, inner_y = x + padding, y + padding
    inner_width, inner_height = width - padding * 2, height - padding * 2
    color = tuple(block.get("color", [18, 18, 18]))
    align = block.get("align", "left")
    min_size = block.get("min_size", block["size"])
    chosen = None
    for size in range(block["size"], min_size - 1, -1):
        face = font(fonts[block["font"]], size)
        lines = block.get("lines") or wrap(draw, block.get("text", ""), face, inner_width)
        spacing = round(size * 0.16)
        line_height = round(size * 1.08)
        title = block.get("title")
        title_size = block.get("title_size", size)
        title_face = font(fonts[block.get("bold_font", block["font"])], title_size)
        title_lines = wrap(draw, title, title_face, inner_width) if title else []
        total = len(title_lines) * round(title_size * 1.08) + (round(size * .2) if title_lines else 0) + len(lines) * line_height
        all_widths = [line_width(draw, item, title_face) for item in title_lines] + [line_width(draw, item, face) for item in lines]
        if len(lines) + len(title_lines) <= block.get("max_lines", 99) and total <= inner_height and all(value <= inner_width for value in all_widths):
            chosen = (size, face, lines, title_face, title_lines, line_height, spacing, total)
            break
    if chosen is None:
        raise SystemExit(f"text does not fit: {block['id']}")
    size, face, lines, title_face, title_lines, line_height, spacing, total = chosen
    cy = inner_y + max(0, (inner_height - total) // 2)

    def draw_lines(items: list[str], use_font: ImageFont.FreeTypeFont, line_step: int) -> None:
        nonlocal cy
        for item in items:
            w = line_width(draw, item, use_font)
            tx = inner_x if align == "left" else inner_x + inner_width - w if align == "right" else inner_x + (inner_width - w) // 2
            draw.text((tx, cy), item, font=use_font, fill=color)
            cy += line_step

    draw_lines(title_lines, title_face, round(title_face.size * 1.08))
    if title_lines:
        cy += round(size * .2)
    draw_lines(lines, face, line_height)
    return {
        "id": block["id"],
        "box": block["box"],
        "nominal_size": block["size"],
        "used_size": size,
        "size_delta_percent": round((size / block["size"] - 1) * 100, 2),
        "line_count": len(lines) + len(title_lines),
        "max_lines": block.get("max_lines"),
        "target_text": " ".join(title_lines + lines),
    }
