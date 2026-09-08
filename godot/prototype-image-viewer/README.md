# Image Viewer — throwaway Godot prototype

Question: does scrolling the artwork inside a resizable screenshot-derived window feel right?
Owner play and follow-up edits decide the answer; no production decision is claimed yet.
Tracked in https://github.com/Reid-Surmeier/qwen-image-pipeline/issues/81,
captured on `prototype/81-image-viewer`, never promoted to main.

Run native from the repository root:

```bash
bash godot/prototype-image-viewer/run.sh
```

Pass `web` to build `web/index.html`. The runner reuses the installed Godot
4.7.2 binary and export templates; override `GODOT_BIN` on another machine.
Use the existing share skill to serve the exported folder.

Wheel/trackpad and the native scrollbar move the artwork. Drag the title bar
to move the window; drag its bottom-right grip to resize. The header/footer
stay fixed, and the artwork keeps its scale while the window changes size.
Narrow windows gain a horizontal scrollbar. Browser viewport changes refit
the whole window for the available display. All state lives in memory.
`window.imageViewer` exposes the interaction state for inspection.

The other screenshot controls remain decorative. This is one requested
Godot interaction study, not the prototype skill's default HTML variants.
Frame patching and drag clamping reuse the approach in
`qwen-pipeline-experiments/benchmarks/atlas-prototype/godot/atlas_window.gd`.

Source reference: Issue #77's latest matching-frame image, found at
`/tmp/claude-image-viewer-two-artworks-fix-issue77/public/image-viewer-matching-frames.png`.
`reference.png` is an unchanged copy, 4679 × 4563, SHA-256
`f98d13adc98d0b17a5dc3f1436cd1faaaea5a4403fe0733fdf1d23c9bc12e7a6`.
It is retained in ordinary Git as a source reference. No paid generations.
Godot samples regions directly from this source. Display scaling is not an
exact native-pixel fidelity claim.

Verification on 2026-09-08: headless Godot import and Web export passed with
no engine errors after correcting the initial script/preset errors.
`node godot/prototype-image-viewer/playtest.mjs [URL]` passed real browser
inputs for both wheel stops, scrollbar dragging, shrinking, title dragging,
expansion/clamping, unchanged artwork size during window resizing, and a
600px browser viewport. No browser or engine errors were captured.
The script reuses the atlas's installed Playwright; it installs nothing.
`evidence/` contains comparison screenshots and the machine-readable report;
initial, scrolled, resized and narrow views were visually inspected.
`scripts/verify.sh` passed: 196 Python tests (2 skipped), 19 Node tests,
Python compilation and diff whitespace check.
