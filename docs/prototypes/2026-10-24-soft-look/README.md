# Agent Comms soft look mockup (approved 2026-10-25)

This is the mockup the owner approved for the desktop app's look in the 0.28.0 redesign: the soft palette, sans
labels, filled rimless panels, and the tab bars and segmented controls as raised pills on a quiet track. It was drawn
as a Claude Design canvas. These files are that canvas's sources, so the mockup doesn't depend on any one Claude
account. The desktop design (`docs/superpowers/specs/2026-10-24-desktop-0270-design.md`) links the original, which is
private to the owner's account: https://claude.ai/artifact/7Z14fMx8Cp3fPfjtxDDJKj

cue-ui built its soft preset (`@cueplusplus/theme-soft`, CUE-571) from this mockup, and the app wears it from 0.34.0.

## Open it on this Mac

```sh
cd docs/prototypes/2026-10-24-soft-look
python3 -m http.server 8324
```

Then open http://localhost:8324/Main.dc.html. The mockup is one clickable screen, with its own light and dark switch.
It needs a local server, not `file://`, because it loads `support.js`, the small viewer written for
`docs/prototypes/2026-10-26-0320` and copied here. It loads Inter from Google Fonts, so it needs the network to show
that face.

## Put it back on a canvas (any Claude account)

Ask Claude to create a Design canvas from `Main.dc.html` and `canvas.json`, both under the canvas's `project/` folder.
Leave out `support.js` and this README, since the canvas brings its own runtime.
