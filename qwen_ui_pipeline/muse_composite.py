"""Unchanged creative controls from the saved DIS composite procedure."""

FORBID = (
    "Do not copy any character, mascot, toy, figure, person, logo, wordmark or "
    "artwork that appears in the advertisement reference. That reference is the "
    "authority for the photograph's own language -- its lens, light, grain, "
    "palette, layout and typesetting -- and for nothing else."
)


def sniff(raw: bytes) -> str:
    """The API returns WebP even though we save it as .png, so the extension lies.

    Declaring image/png over WebP bytes is rejected outright, which is what broke
    the first refine pass. Read the magic number instead of trusting the name.
    """
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return "application/octet-stream"


REFINE = """
This image is a 1999 magazine advertisement that has been retouched, and the retouching has left
errors. Correct only those errors. Change nothing else.

Make the whole frame read as one photograph. Carry the same fine photographic grain across every
part of it, including the retouched areas, and the same slight softness the lens gives away from
the centre. Remove any smooth, waxy or plastic look on skin, hair, fabric and objects; any
airbrushed gradient; any glow, halo or bright fringe along an edge where something was cut in; and
any area that is cleaner, sharper or more saturated than the photograph around it.

Correct malformed hands, fingers, teeth, ears and eyes, and any limb that joins a body wrongly.
Correct any object whose shape is impossible, and any shadow falling in a different direction from
the rest of the frame.

The page itself stays clean and new. Do not add paper texture, print dots, fibre, foxing, stains,
mottling, creases, curl, yellowing or any other sign of age or scanning.

Do not move, add, remove, resize or restyle anything. Every person, every object and every word of
type stays exactly where it is, at the same size, in the same typeface, spelled exactly as it is
now. Do not re-typeset any text.
""".strip()
