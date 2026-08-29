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

rendererInstance = createRenderer(canvas, labelContainer);

// ── Load example patterns ──────────────────────────────────────────────────────

fetch('./examples/examples.json')
  .then(r => r.json())
  .then(examples => {
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
  })
  .catch(() => {
    // Fallback: show a basic default pattern if examples.json isn't found
    patternInput.value = DEFAULT_PATTERN;
    doRender();
  });

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
