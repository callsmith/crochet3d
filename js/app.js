/**
 * app.js — Application Controller
 *
 * Wires together:
 *   parser.js   → parsePattern()
 *   builder.js  → buildGraph()
 *   geometry.js → computePositions()
 *   renderer.js → createRenderer()
 *
 * Handles all UI events and state.
 */

import { parsePattern }    from './parser.js';
import { buildGraph }      from './builder.js';
import { computePositions } from './geometry.js';
import { createRenderer }  from './renderer.js';

// ── DOM references ─────────────────────────────────────────────────────────────

const patternInput    = document.getElementById('pattern-input');
const renderBtn       = document.getElementById('render-btn');
const resetCameraBtn  = document.getElementById('reset-camera-btn');
const stuffingSlider  = document.getElementById('stuffing-slider');
const stuffingValue   = document.getElementById('stuffing-value');
const errorBox        = document.getElementById('error-box');
const warningBox      = document.getElementById('warning-box');
const statsBox        = document.getElementById('stats-box');

const chkNodes        = document.getElementById('chk-nodes');
const chkEdges        = document.getElementById('chk-edges');
const chkLabels       = document.getElementById('chk-labels');
const chkRoundLabels  = document.getElementById('chk-round-labels');

const canvas          = document.getElementById('three-canvas');
const labelContainer  = document.getElementById('label-container');

const exampleSelect   = document.getElementById('example-select');

// ── State ──────────────────────────────────────────────────────────────────────

let rendererInstance = null;
let currentGraph     = null;

// ── Initialise renderer ────────────────────────────────────────────────────────

// Wrap in try/catch so a WebGL failure does not abort the rest of module
// initialisation (the dropdown, event listeners, and fetch all live below this
// line and would be silently skipped if the exception were left uncaught).
try {
  rendererInstance = createRenderer(canvas, labelContainer);
} catch (e) {
  showError(`3D renderer unavailable: ${e.message}`);
}

// ── Load example patterns ──────────────────────────────────────────────────────

// Inline copy of examples/examples.json so the dropdown always works,
// even when the page is opened via file:// or when the JSON fetch fails.
const BUILTIN_EXAMPLES = [
  { name: 'Simple Ball (8 rounds)',      pattern: 'R1: MR 6\nR2: INC x6\nR3: (SC, INC) x6\nR4: (SC 2, INC) x6\nR5: SC 24\nR6: (SC 2, DEC) x6\nR7: (SC, DEC) x6\nR8: DEC x6' },
  { name: 'Larger Ball (10 rounds)',     pattern: 'R1: MR 6\nR2: INC x6\nR3: (SC, INC) x6\nR4: (SC 2, INC) x6\nR5: (SC 3, INC) x6\nR6: SC 30\nR7: SC 30\nR8: (SC 3, DEC) x6\nR9: (SC 2, DEC) x6\nR10: (SC, DEC) x6\nR11: DEC x6' },
  { name: 'Egg / Oval',                  pattern: 'R1: MR 6\nR2: INC x6\nR3: (SC, INC) x6\nR4: SC 18\nR5: SC 18\nR6: SC 18\nR7: (SC, DEC) x6\nR8: DEC x6' },
  { name: 'Localized Bumps Test',        pattern: 'R1: MR 6\nR2: INC x6\nR3: SC 12\nR4: SC 5, INC 3, SC 4\nR5: SC 5, INC 3, SC 7\nR6: SC 18\nR7: SC 18\nR8: (SC, DEC) x6\nR9: DEC x6' },
  { name: 'Localized Decrease Test',     pattern: 'R1: MR 6\nR2: INC x6\nR3: (SC, INC) x6\nR4: SC 18\nR5: SC 4, DEC 3, SC 5\nR6: SC 12\nR7: (SC, DEC) x4\nR8: DEC x4' },
  { name: 'Cylinder / Tube',             pattern: 'R1: MR 8\nR2: INC x8\nR3: SC 16\nR4: SC 16\nR5: SC 16\nR6: SC 16\nR7: SC 16\nR8: SC 16\nR9: DEC x8' },
  { name: 'Simple SC Only',              pattern: 'R1: MR 6\nR2: SC 6\nR3: SC 6\nR4: SC 6\nR5: SC 6' },
];

function loadExamples(examples) {
  examples.forEach((ex, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = ex.name;
    exampleSelect.appendChild(opt);
  });

  // Load first example by default
  if (examples.length > 0) {
    patternInput.value = examples[0].pattern;
    doRender();
  }

  exampleSelect.addEventListener('change', () => {
    const ex = examples[parseInt(exampleSelect.value, 10)];
    if (ex) {
      patternInput.value = ex.pattern;
      doRender();
    }
  });
}

// Try fetching the JSON first; fall back to the inline copy on any error.
fetch('./examples/examples.json')
  .then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(examples => loadExamples(examples))
  .catch(() => loadExamples(BUILTIN_EXAMPLES));

// ── UI event handlers ─────────────────────────────────────────────────────────

renderBtn.addEventListener('click', doRender);
resetCameraBtn.addEventListener('click', () => rendererInstance?.resetCamera());

stuffingSlider.addEventListener('input', () => {
  stuffingValue.textContent = stuffingSlider.value;
  if (currentGraph) reRender();
});

[chkNodes, chkEdges, chkLabels, chkRoundLabels].forEach(el => {
  el.addEventListener('change', () => { if (currentGraph) reRender(); });
});

// Allow Ctrl+Enter in the textarea to trigger render
patternInput.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doRender();
});

// ── Core pipeline ──────────────────────────────────────────────────────────────

function doRender() {
  clearMessages();

  if (!rendererInstance) {
    showError('WebGL renderer is not available. Please enable hardware acceleration in your browser settings.');
    return;
  }

  const text = patternInput.value.trim();
  if (!text) { showError('Please enter a crochet pattern.'); return; }

  // 1. Parse
  const parsed = parsePattern(text);
  if (parsed.errors.length) {
    showError(parsed.errors.join('\n'));
    return;
  }
  if (parsed.rounds.length === 0) {
    showError('No rounds found in pattern.');
    return;
  }

  // 2. Build stitch graph
  const { graph, warnings } = buildGraph(parsed);
  currentGraph = graph;

  if (warnings.length) showWarnings(warnings);

  // 3. Compute positions
  const stuffing = parseFloat(stuffingSlider.value);
  computePositions(graph, stuffing);

  // 4. Render
  rendererInstance.render(graph, getOptions());

  // 5. Stats
  showStats(graph);
}

function reRender() {
  if (!currentGraph) return;
  const stuffing = parseFloat(stuffingSlider.value);
  computePositions(currentGraph, stuffing);
  rendererInstance.render(currentGraph, getOptions());
}

function getOptions() {
  return {
    showNodes:       chkNodes.checked,
    showEdges:       chkEdges.checked,
    showLabels:      chkLabels.checked,
    showRoundLabels: chkRoundLabels.checked,
  };
}

// ── Message helpers ────────────────────────────────────────────────────────────

function clearMessages() {
  errorBox.textContent   = '';
  errorBox.style.display = 'none';
  warningBox.textContent   = '';
  warningBox.style.display = 'none';
}

function showError(msg) {
  errorBox.textContent   = msg;
  errorBox.style.display = 'block';
}

function showWarnings(msgs) {
  warningBox.textContent   = msgs.join('\n');
  warningBox.style.display = 'block';
}

function showStats(graph) {
  const edges = graph.edges;
  const roundCounts = graph.rounds.map((r, i) => `R${i + 1}: ${r.length}st`).join('  ');
  statsBox.textContent = `${graph.rounds.length} rounds · ${graph.totalStitches} stitches · ${edges.length} edges\n${roundCounts}`;
}

// ── Fallback default pattern ───────────────────────────────────────────────────

const DEFAULT_PATTERN = `R1: MR 6
R2: INC x6
R3: (SC, INC) x6
R4: (SC 2, INC) x6
R5: SC 24
R6: (SC 2, DEC) x6
R7: (SC, DEC) x6
R8: DEC x6`;
