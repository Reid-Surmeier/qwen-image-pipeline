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

Wheel/trackpad scroll vertically; both scrollbars are hidden and horizontal
scrolling is disabled. Drag the title bar to move the window; drag its
bottom-right grip to resize. Seven fixed-size artwork cards wrap into fewer
columns in Godot's native HFlowContainer. The first print keeps its original
three icon groups. Card sizes remain fixed at 37.5% of source pixels
through window resizing and browser viewport changes. The window's minimum
resize width fits the widest card, 531 display pixels including padding.
The header/footer stay attached; their chrome fits narrow displays.
All state lives in memory.
`window.imageViewer` exposes the interaction state for inspection.

The other screenshot controls remain decorative. This is one requested
Godot interaction study, not the prototype skill's default HTML variants.
Frame patching and drag clamping reuse the approach in
`qwen-pipeline-experiments/benchmarks/atlas-prototype/godot/atlas_window.gd`.

The desktop now follows the owner's layout reference: equipment, options,
Search filters, status, trade and chat on the left; gallery at upper right;
party below it; bottom bar in its shown position. The owner removed the
2ND ALBUM label and expanded the gallery to the bottom bar's right edge.
Artwork dimensions are 50% larger than the earlier prototype.
All eight companion windows can now be moved by dragging their title bars;
the bottom strip can be dragged anywhere on its surface. Clicking a window
brings it forward, only the topmost overlapping window receives the drag,
and movement clamps to the viewport. Internal controls remain decorative.
Their initial layout
scales together to fit the desktop while artwork cards keep their fixed size.
At very narrow browser widths the gallery keeps its minimum card width and
can cover surrounding panels; the supplied multi-window layout targets desktop.
The gallery also remains resizable; companion windows keep their sizes.
`assets/SOURCES.md` records source identities and hashes. A shader removes
magenta only within the outer 32 source pixels (3 for the small filters crop), preserving
pink colors in the interior. Original PNGs remain unchanged.

Source reference: the owner's replacement seven-artwork landscape screenshot,
`/tmp/orca-paste-1788871973810-2fd26ef1-8eee-499c-a00f-ee95924f971b.png`.
`reference.png` is an unchanged copy, 4591 × 2816, SHA-256
`c39ac61850b59fe297ffc2a09fcd30adbdb37c78181275248344a5e5016ad501`.
The earlier three-artwork reference remains in Git history at `b6ae260`.
The desktop background is white. Godot draws a clean rounded outline and
samples only the source's interior header, footer and artwork; the noisy,
magenta outer perimeter is excluded from every sampled region.
It is retained in ordinary Git as a source reference. No paid generations.
Godot samples regions directly from this source. Display scaling is not an
exact native-pixel fidelity claim.

Verification on 2026-09-08: headless Godot import and Web export passed with
no engine errors after correcting the initial script/preset errors.
`node godot/prototype-image-viewer/playtest.mjs [URL]` passed real browser
inputs for both wheel stops, hidden scrollbars, disabled horizontal movement,
shrinking, title dragging, expansion/clamping, unchanged sizes of all seven
artwork cards, non-overlap and horizontal containment at desktop, 600px and
560px browser viewports, and reaching the last work through vertical scrolling.
The updated smoke run also asserts all eight companion panels are present and
captures the supplied desktop layout at 1944 × 1280 and 1200 × 800.
Real-input checks move all eight panels, verify stable sizes and body-drag
rejection, then put equipment over the gallery and bring the gallery back
in front to verify that only the visible window responds at an overlap.
No browser or engine errors were captured.
The script reuses the atlas's installed Playwright; it installs nothing.
`evidence/` contains comparison screenshots and the machine-readable report;
initial, scrolled, resized and narrow views were visually inspected.
`scripts/verify.sh` passed: 196 Python tests (2 skipped), 19 Node tests,
Python compilation and diff whitespace check.
