"""Local image decoder: bytes on stdin, closed media properties on stdout. No network."""
import io
import json
import sys
from PIL import Image


def inspect(raw):
    with Image.open(io.BytesIO(raw)) as image:
        image.load()
        media_type = Image.MIME.get(image.format)
        if media_type not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValueError("unsupported image")
        return {"kind": "image", "mediaType": media_type, "width": image.width, "height": image.height}


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(sys.stdin.buffer.read())))
    except Exception:
        print('{"error":"unsupported-or-malformed-image"}')
        raise SystemExit(2) from None
