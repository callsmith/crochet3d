# 🧶 Crochet 3D

**Crochet 3D** is a browser-based MVP that converts amigurumi crochet patterns
into an interactive 3D wireframe.  Paste a pattern → click Render → inspect
the stitch graph in real time.

---

## Live Demo

Deploy to GitHub Pages (see below) or open `index.html` directly via a local
server.

---

## Features

* Parses rounds using common amigurumi notation (`MR`, `SC`, `INC`, `DEC`,
  `SCTOG`, parenthetical repetition)
* Builds a complete **stitch graph** with parent / child and same-round
  neighbor relationships
* Visualises nodes (colour-coded by stitch type) and edges (parent vs
  neighbor) in an interactive Three.js scene
* **Stuffing factor** slider inflates / deflates the shape in real time
* Debug toggles for node visibility, edge visibility, stitch labels, and round
  labels
* Several built-in example patterns
* Completely client-side — no server, no build step

---

## Supported Pattern Syntax

```
R1: MR 6
R2: INC x6
R3: (SC, INC) x6
R4: (SC 2, INC) x6
R5: SC 24
R6: (SC 2, DEC) x6
```

| Token | Description |
|-------|-------------|
| `MR n` | Magic Ring — creates `n` foundation stitches |
| `SC` | Single Crochet — 1 parent, 1 child |
| `SC n` | `n` consecutive Single Crochets |
| `INC` | Increase — 1 parent, 2 children |
| `DEC` / `SCTOG` | Decrease — 2 parents, 1 child |
| `(…) xN` | Repeat the group N times |
| `R1:` prefix | Optional round label; parsed but not required |
| `//` or `#` lines | Comments — ignored |

The parser preserves **exact stitch order**.  Localized clusters of `INC` or
`DEC` remain spatially localized in the wireframe.

---

## Project Structure

```
crochet3d/
├── index.html          Main HTML shell
├── css/
│   └── style.css       Application styles
├── js/
│   ├── model.js        StitchGraph data model (topology only)
│   ├── parser.js       Pattern text → array of round operations
│   ├── builder.js      Round operations → StitchGraph with relationships
│   ├── geometry.js     StitchGraph → 3D positions (stuffing factor here)
│   ├── renderer.js     Three.js wireframe renderer
│   └── app.js          UI controller — wires everything together
└── examples/
    └── examples.json   Built-in example patterns
```

### Architecture pipeline

```
Pattern text
    ↓  parser.js
Array of round ops (ordered)
    ↓  builder.js
StitchGraph (topology)
    ↓  geometry.js
StitchGraph (with positions)
    ↓  renderer.js
Three.js scene
```

Each layer is independent.  The parser knows nothing about 3D.  The renderer
knows nothing about crochet notation.

---

## Stitch Graph Model

Each `Stitch` node carries:

| Field | Description |
|-------|-------------|
| `id` | Unique integer |
| `type` | `MR` / `SC` / `INC` / `DEC` |
| `round` | 0-based round index |
| `indexInRound` | 0-based position within the round |
| `parents[]` | Stitches in the previous round worked into |
| `children[]` | Stitches in the next round that work into this |
| `prevInRound` / `nextInRound` | Circular neighbor chain |
| `position` | `{ x, y, z }` — set by geometry.js |

`INC` → 1 parent, 2 children.  `DEC` → 2 parents, 1 child.  The graph
supports any number of parents/children to accommodate future stitch types.

---

## Stuffing Factor

The stuffing factor (0 – 1) blends between two radius profiles:

* `0` (flat) — each round's radius is derived purely from its stitch count
* `1` (full) — every round expands to the maximum stitch count, producing a
  barrel/cylinder-like silhouette

The Y spacing between rounds also compresses as stuffing increases to keep the
shape looking rounded rather than stretched.

---

## GitHub Pages Deployment

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Set **Source** to "Deploy from a branch", branch `main`, folder `/` (root).
4. Save — the site will be live at `https://<user>.github.io/<repo>/`.

No build step is required.  `index.html` is the root document.  Three.js is
loaded from jsDelivr CDN at runtime.

---

## Local Development

Because the app uses ES modules and loads `examples/examples.json` via
`fetch`, a local HTTP server is needed (browsers block `fetch` on `file://`):

```bash
# Python 3
python -m http.server 8080

# Node.js (npx)
npx serve .

# VS Code
# Install the "Live Server" extension and click "Go Live"
```

Then open `http://localhost:8080`.

---

## Extending the Stitch Set

To add a new stitch type (e.g. `HDC`, `DC`, `CH`):

1. **`js/model.js`** — add an entry to `StitchType`.
2. **`js/parser.js`** — add the keyword to `STITCH_ALIASES`.
3. **`js/builder.js`** — add a `case` in the `switch` block with the correct
   parent-consumption and child-production rules.
4. **`js/geometry.js`** — add stitch width/height values if the new stitch should
   occupy a different round spacing or parent-edge length.
5. **`js/renderer.js`** — optionally add a colour in `COLORS` and update
   `nodeColor()`.

No other files need to change.

---

## Example Patterns

| Name | Description |
|------|-------------|
| Simple Ball (8 rounds) | Classic amigurumi sphere |
| Larger Ball (10 rounds) | Bigger sphere with a flat middle |
| Egg / Oval | Elongated form |
| Localized Bumps Test | INC cluster on one side → visible bulge |
| Localized Decrease Test | DEC cluster on one side → visible indent |
| Cylinder / Tube | Straight-walled form |
| Simple SC Only | Minimal all-SC test case |

---

## Future Work

* HDC, DC, CH, SL stitch types
* Concentric-circle (Asian-style) flat view of rounds
* Smooth subdivision surface over the stitch graph
* Realistic stitch-shaped geometry and yarn thickness
* Materials and colors per stitch region
* Non-continuous constructions (chains, skips, surface attachments)
* Export to OBJ / glTF
