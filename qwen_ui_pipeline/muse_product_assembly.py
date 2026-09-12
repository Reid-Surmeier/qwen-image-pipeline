"""Preserved gallery Assembly; only the explicit saved application recipe is supported."""
from __future__ import annotations
import copy, hashlib, json, re, subprocess
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw
from .muse_typeset import draw_block, make_erase_mask, make_region_mask, normalize, sha256, synthesize_scan_background
# Application constants and ROOT/HOME are supplied by the single-invocation recipe host.

def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def words(value: str, count: int) -> str:
    values = value.strip().split()
    result = " ".join(values[:count])
    if result and result[-1] not in ".!?":
        result += "."
    return result


def phrase(value: str, count: int) -> str:
    return " ".join(value.strip().split()[:count]).rstrip(".,;:")


def line_regions(lines: list[list[list[int]]], padding: int = 16) -> list[dict]:
    regions = []
    for points in lines:
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        regions.append({"box": [min(xs) - padding, min(ys) - padding, max(xs) - min(xs) + padding * 2, max(ys) - min(ys) + padding * 2]})
    return regions


def padded_regions(regions: list[dict], padding: int) -> list[dict]:
    return [
        {
            "box": [
                region["box"][0] - padding,
                region["box"][1] - padding,
                region["box"][2] + padding * 2,
                region["box"][3] + padding * 2,
            ]
        }
        for region in regions
    ]


def load_source(layout: dict) -> Image.Image:
    if "source" in layout:
        return Image.open(ROOT / layout["source"]).convert("RGB")
    pages = [Image.open(ROOT / source).convert("RGB") for source in layout["sources"]]
    output = Image.new("RGB", (sum(page.width for page in pages), pages[0].height), "white")
    offset = 0
    for page in pages:
        output.paste(page, (offset, 0))
        offset += page.width
    return output


def row_paper(source: np.ndarray, top: int, bottom: int, width: int, seed: int) -> np.ndarray:
    gray = cv2.cvtColor(source, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(source, cv2.COLOR_RGB2HSV)
    paper = np.empty((bottom - top, width, 3), dtype=np.float32)
    for offset, source_y in enumerate(range(top, bottom)):
        light = (gray[source_y] > 228) & (hsv[source_y, :, 1] < 36)
        median = np.median(source[source_y, light], axis=0) if np.count_nonzero(light) > 100 else [246, 246, 246]
        paper[offset] = median
    paper += np.random.default_rng(seed).normal(0, 0.72, paper.shape)
    return np.clip(paper, 0, 255).astype(np.uint8)


def clean_template(name: str, layout: dict, source: Image.Image) -> Image.Image:
    source_array = np.array(source)
    copy_mask = make_erase_mask(source_array, layout["blocks"] + layout.get("erase_regions", []))
    cleared = cv2.inpaint(source_array, copy_mask, 9, cv2.INPAINT_TELEA)
    cleared = synthesize_scan_background(cleared, layout.get("erase_regions", []))

    x, y, width, height = PRODUCT_REGIONS[name]["box"]
    object_mask = np.zeros(source_array.shape[:2], dtype=np.uint8)
    object_mask[y:y + height, x:x + width] = 255
    for region in OLD_LEADER_ERASE_REGIONS[name]:
        rx, ry, rw, rh = region["box"]
        object_mask[ry:ry + rh, rx:rx + rw] = 255
    for points in OLD_LEADERS[name]:
        cv2.polylines(
            object_mask,
            [np.array(points, dtype=np.int32)],
            False,
            255,
            thickness=70 if name == "canon" else 44,
        )

    active_y, active_x = np.nonzero(object_mask)
    left, right = int(active_x.min()), int(active_x.max()) + 1
    top, bottom = int(active_y.min()), int(active_y.max()) + 1
    paper = row_paper(source_array, top, bottom, right - left, 4100 if name == "kodak" else 4101)
    feather = cv2.GaussianBlur(object_mask[top:bottom, left:right], (0, 0), sigmaX=7).astype(np.float32)[:, :, None] / 255.0
    current = cleared[top:bottom, left:right].astype(np.float32)
    cleared[top:bottom, left:right] = np.clip(current * (1.0 - feather) + paper * feather, 0, 255).astype(np.uint8)
    return Image.fromarray(cleared)


def alpha_crop(donor: Image.Image, crop_mode: str) -> Image.Image:
    rgb = donor.convert("RGB")
    if crop_mode == "primary":
        rgb = rgb.crop((0, 0, round(rgb.width * 0.62), rgb.height))
    elif crop_mode == "primary-offline":
        rgb = rgb.crop((0, 0, round(rgb.width * 0.82), rgb.height))
    pixels = np.array(rgb, dtype=np.uint8)
    array = pixels.astype(np.float32)
    corners = np.concatenate([
        array[:40, :40].reshape(-1, 3), array[:40, -40:].reshape(-1, 3),
        array[-40:, :40].reshape(-1, 3), array[-40:, -40:].reshape(-1, 3),
    ])
    background = np.median(corners, axis=0)
    if crop_mode == "primary-offline":
        pixels[:650, 1130:] = background.astype(np.uint8)
        pixels[900:, 1240:] = background.astype(np.uint8)
        array = pixels.astype(np.float32)
    distance = np.max(np.abs(array - background), axis=2)
    alpha = (np.clip((distance - 10.0) / 18.0, 0.0, 1.0) * 255).astype(np.uint8)
    rgba = Image.fromarray(np.dstack([pixels, alpha]), "RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if not bbox:
        raise RuntimeError("donor alpha is empty")
    padding = 20
    box = (max(0, bbox[0] - padding), max(0, bbox[1] - padding), min(rgba.width, bbox[2] + padding), min(rgba.height, bbox[3] + padding))
    return rgba.crop(box)


def place_donor(canvas: Image.Image, donor: Image.Image, crop_mode: str, target: list[int]) -> list[int]:
    layer = alpha_crop(donor, crop_mode)
    tx, ty, tw, th = target
    scale = min(tw / layer.width, th / layer.height)
    width, height = round(layer.width * scale), round(layer.height * scale)
    layer = layer.resize((width, height), Image.Resampling.LANCZOS)
    x, y = tx + (tw - width) // 2, ty + (th - height) // 2
    canvas.alpha_composite(layer, (x, y))
    return [x, y, width, height]


def dynamic_blocks(name: str, layout: dict, packet: dict, strategy: str) -> list[dict]:
    blocks = copy.deepcopy(layout["blocks"])
    by_id = {block["id"]: block for block in blocks}
    product_short = packet["product"].replace(" Executive", "")
    maker_short = packet["maker"].replace(" Technologies", "").replace(" Products", "")
    family = packet["product"].split()[0]
    web_name = slug(maker_short.replace("DIS ", ""))
    product_web = slug(product_short.split()[0])

    if name == "kodak":
        by_id["manufacturer"]["lines"] = [KODAK_CATEGORIES[family], packet["maker"].upper()]
        by_id["manufacturer"]["min_size"] = 68
        by_id["headline"].pop("lines", None)
        by_id["headline"]["text"] = "Identification before connection." if packet["product"].startswith("OfflineMark") else packet["headline"]
        by_id["headline"]["max_lines"] = 3
        by_id["headline"]["min_size"] = 150
        callout_ids = ["picture_card_callout", "display_callout", "quality_callout", "paper_callout", "connection_callout"]
        callouts = KODAK_CALLOUTS[family]
        for block_id, (title, text) in zip(callout_ids, callouts):
            block = by_id[block_id]
            block["title"] = phrase(title.upper(), 4)
            block["text"] = words(text, 11)
            block["min_size"] = max(48, block["size"] - 14)
        by_id["price"]["title"] = packet["price"]
        by_id["price"]["text"] = f"Available through {packet['maker']}. Managed service applies."
        by_id["response"]["text"] = f"For specifications visit www.dis-{web_name}.example/{product_web} or call 1-800-DIS-SYS."
        by_id["retailers"]["lines"] = ["SYSTEMS WAREHOUSE     APPROVED OFFICE     CIVIC SUPPLY     MANAGED SERVICE"]
        by_id["retailers"]["min_size"] = 62
        by_id["legal"]["text"] = f"© 1999 {packet['maker']}. {product_short} and its operating system are trademarks. Managed service sold separately."
    else:
        quote_variant = "specification" in strategy
        by_id["quote_top"]["text"] = f"“...{words(packet['testimonial']['quote'], 11).rstrip('.')}...”"
        by_id["quote_upper_right"]["text"] = f"“{words(packet['directUses'][0], 9)}”"
        by_id["quote_lower_left"]["text"] = f"“a managed system at {packet['price']}”"
        by_id["quote_bottom"]["text"] = f"“We were impressed by {product_short}'s controlled process...”"
        headline_product = packet["product"].split()[0]
        if headline_product == "OfflineMark" and quote_variant:
            by_id["headline"]["lines"] = ["Systems Review examined", "OfflineMark.", "The process remained controlled."]
            by_id["headline"]["min_size"] = 160
        elif headline_product == "OfflineMark":
            by_id["headline"]["lines"] = ["Systems Review tested", "OfflineMark.", "Every operation was recorded."]
            by_id["headline"]["min_size"] = 160
        elif quote_variant:
            by_id["headline"]["lines"] = ["Applied Product Review examined", f"the {headline_product} system.", "The process remained controlled."]
        else:
            by_id["headline"]["lines"] = ["Applied Product Review tested", f"our {headline_product} system.", "Every operation was accounted for."]
        by_id["headline"].setdefault("min_size", 190)
        feature_lines = [f"• {phrase(item['name'], 7)}" for item in packet["features"][:3]]
        feature_lines += [f"• {phrase(packet['objectionableTrait'], 9)}", "• Scheduled DIS authorization for managed operation"]
        by_id["specifications"]["title"] = f"The {product_short}. {phrase(packet['headline'], 7)}."
        by_id["specifications"]["text"] = "\n".join(feature_lines)
        by_id["specifications"]["min_size"] = 60
        by_id["certification"]["lines"] = ["DIS CERTIFIED", "MANAGED OPERATION"]
        by_id["response"]["text"] = f"We gave the editors at Applied Product Review our {product_short} for evaluation. Their conclusion confirmed its controlled purpose: {words(packet['mechanism'], 18).lower()} For specifications visit www.dis-{web_name}.example/{product_web} or call 1-800-DIS-SYS."
        by_id["response"]["min_size"] = 56
        by_id["manufacturer"]["lines"] = [phrase(packet["headline"], 5), maker_short.upper()]
        by_id["manufacturer"]["min_size"] = 90
        by_id["legal"]["text"] = f"© 1999 {packet['maker']}. {product_short} is a trademark. Applied Product Review is a fictional publication identity. Managed service and operating restrictions apply."
    return blocks


def new_leaders(template: str, bbox: list[int], packet: dict, strategy: str) -> list[list[list[int]]]:
    x, y, width, height = bbox
    if template == "kodak":
        family = packet["product"].split()[0]
        anchors = KODAK_ANCHORS[family][strategy]
        targets = [[x + round(width * px), y + round(height * py)] for px, py in anchors]
        return [
            [[650, 2880], [650, 3200], targets[0]],
            [[2540, 2170], targets[1]],
            [[4300, 2790], [3950, 2790], targets[2]],
            [[700, 4260], [700, 4100], targets[3]],
            [[4460, 4460], [4700, 4460], [4700, 4130], targets[4]],
            [[2440, 4620], [2440, 4810]],
        ]
    anchors = [(0.26, 0.22), (0.78, 0.25), (0.22, 0.72), (0.68, 0.78)]
    if packet["product"].startswith("EntryBrief") and strategy == "canon-specification":
        anchors = [(0.25, 0.30), (0.68, 0.38), (0.22, 0.72), (0.65, 0.80)]
    targets = [[x + round(width * px), y + round(height * py)] for px, py in anchors]
    return [
        [[1590, 500], targets[0]],
        [[4160, 1030], targets[1]],
        [[1430, 3330], targets[2]],
        [[3520, 3940], targets[3]],
    ]


def page_ocr(path: Path) -> str:
    result = subprocess.run(["tesseract", str(path), "stdout", "--psm", "11"], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def assemble_one(index: int, packet: dict, variant: dict, attempts: list[dict], layouts: dict, sources: dict, clean: dict, reuse_existing: bool = False) -> dict:
    strategy = variant["strategy"]
    template = variant["template"]
    family = packet["product"].split()[0]
    crop_mode = variant["crop"]
    if strategy == "kodak-hero" and family == "OfflineMark":
        crop_mode = "primary-offline"
    elif strategy == "canon-endorsement" and family == "OfflineMark":
        crop_mode = "primary-offline"
    elif strategy == "canon-endorsement" and family in {"BoilPlan", "EntryBrief", "Singular"}:
        crop_mode = "all"
    packet_attempts = [attempt for attempt in attempts if attempt["packetSignature"] == packet["signature"]]
    donor_index = min(variant["donor"], len(packet_attempts) - 1)
    attempt = packet_attempts[donor_index]
    run_path = HOME / "attempts" / attempt["id"] / "run.json"
    run = json.loads(run_path.read_text())
    donor_path = ROOT / run["images"][0]["file"]
    donor = Image.open(donor_path).convert("RGB")

    blocks = dynamic_blocks(template, layouts[template], packet, strategy)
    identifier = f"{index:02d}-{slug(packet['product'])}-{strategy}"
    final_dir = HOME / "final"
    preview_dir = HOME / "previews"
    final_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)
    output_path = final_dir / f"{identifier}.webp"
    preview_path = preview_dir / f"{identifier}.jpg"
    if reuse_existing:
        if not output_path.exists() or not preview_path.exists():
            raise SystemExit(f"cannot resume missing output {identifier}")
        layer = alpha_crop(donor, crop_mode)
        tx, ty, tw, th = variant["target"]
        scale = min(tw / layer.width, th / layer.height)
        width, height = round(layer.width * scale), round(layer.height * scale)
        bbox = [tx + (tw - width) // 2, ty + (th - height) // 2, width, height]
        output = Image.open(output_path).convert("RGB")
        fits = []
    else:
        canvas = clean[template].copy().convert("RGBA")
        bbox = place_donor(canvas, donor, crop_mode, variant["target"])
        output = canvas.convert("RGB")
        leaders = new_leaders(template, bbox, packet, strategy)
        draw = ImageDraw.Draw(output)
        for points in leaders:
            draw.line([tuple(point) for point in points], fill=(165, 165, 161) if template == "kodak" else (70, 70, 68), width=4, joint="curve")
        fits = [draw_block(draw, block, layouts["fonts"]) for block in blocks]
        output.save(output_path, "WEBP", lossless=True, method=4)
        preview = output.copy()
        preview.thumbnail((2200, 1600), Image.Resampling.LANCZOS)
        preview.save(preview_path, "JPEG", quality=93, subsampling=0, optimize=True)

    leaders = new_leaders(template, bbox, packet, strategy)

    reopened = np.array(Image.open(output_path).convert("RGB"))
    output_array = np.array(output)
    lossless_round_trip = bool(np.array_equal(reopened, output_array))
    source_array = np.array(sources[template])
    erased_regions = [PRODUCT_REGIONS[template]] + OLD_LEADER_ERASE_REGIONS[template]
    declared = layouts[template]["blocks"] + layouts[template].get("erase_regions", []) + padded_regions(erased_regions, 30) + PRODUCT_CLEANUP_REGIONS[template] + line_regions(leaders, 20) + line_regions(OLD_LEADERS[template], 70)
    allowed = make_region_mask(source_array, declared)
    changed = np.any(source_array != output_array, axis=2)
    outside = int(np.count_nonzero(changed & (allowed == 0)))
    readback = page_ocr(output_path)
    target_text = " ".join(
        [block.get("title", ""), " ".join(block.get("lines", [])), block.get("text", "")][part]
        for block in blocks
        for part in range(3)
    )
    target_tokens = set(normalize(target_text))
    found_tokens = set(normalize(readback))
    coverage = round(len(target_tokens & found_tokens) / len(target_tokens), 3) if target_tokens else 1.0
    banned_found = sorted(BANNED[template] & found_tokens)
    valid = outside == 0 and coverage >= 0.70 and not banned_found and lossless_round_trip
    return {
        "id": identifier,
        "accepted": False,
        "machineValid": valid,
        "visualVerdict": "pending",
        "blindVerdict": "pending",
        "template": template,
        "strategy": strategy,
        "packetSeed": packet["seed"],
        "packetSignature": packet["signature"],
        "conceptMode": packet["conceptMode"]["id"],
        "maker": packet["maker"],
        "product": packet["product"],
        "headline": packet["headline"],
        "output": str(output_path.relative_to(ROOT)),
        "outputSha256": sha256(output_path),
        "preview": str(preview_path.relative_to(ROOT)),
        "previewSha256": sha256(preview_path),
        "dimensionsPx": list(output.size),
        "sourceSha256": sha256(ROOT / layouts[template].get("source", layouts[template].get("sources", [""])[0])) if template == "kodak" else [sha256(ROOT / item) for item in layouts[template]["sources"]],
        "donorAttempt": attempt["id"],
        "donor": str(donor_path.relative_to(ROOT)),
        "donorSha256": run["images"][0]["sha256"],
        "donorStrategy": attempt["strategy"],
        "provider": run["provider"],
        "model": run["model"],
        "costUsd": run["costUsd"],
        "placementBbox": bbox,
        "cropMode": crop_mode,
        "changedPixelsOutsideDeclaredMasks": outside,
        "ocrTokenCoverage": coverage,
        "bannedSourceTokensFound": banned_found,
        "losslessRoundTrip": lossless_round_trip,
        "fitResults": fits,
    }
