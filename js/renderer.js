/**
 * renderer.js — Three.js Wireframe Renderer
 *
 * Responsible only for converting a StitchGraph (with positions already
 * assigned by geometry.js) into a Three.js scene and managing the canvas.
 *
 * Public API:
 *   createRenderer(canvas)    → RendererInstance
 *
 * RendererInstance:
 *   .render(graph, options)   — rebuild scene from graph
 *   .resetCamera()            — return camera to default position
 *   .dispose()                — clean up Three.js resources
 *
 * Visual conventions:
 *   Nodes (spheres)
 *     MR  → grey
 *     SC  → white/light grey
 *     INC → green
 *     DEC → red/orange
 *
 *   Edges
 *     parent-child → blue
 *     same-round neighbor → yellow
 *
 * Labels are created as CSS2DObjects (Three.js CSS2DRenderer) so they always
 * face the camera and are easily readable.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/renderers/CSS2DRenderer.js';
import { StitchType } from './model.js';

// ─── Colour palette ────────────────────────────────────────────────────────────

const COLORS = {
  background: 0x1a1a2e,
  nodeMR:     0x888899,
  nodeSC:     0xccccdd,
  nodeINC:    0x44dd77,
  nodeDEC:    0xff6644,
  edgeParent: 0x4488ff,
  edgeNeighbor: 0xffcc00,
};

const NODE_RADIUS = 0.06;

/**
 * Create and return a renderer instance bound to the given canvas element.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} labelContainer  — DOM element for CSS2D labels
 * @returns {RendererInstance}
 */
export function createRenderer(canvas, labelContainer) {
  // ── Three.js core ─────────────────────────────────────────────────────────
  const scene    = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);

  const camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.01, 1000);
  camera.position.set(0, 0, 8);

  // Try WebGL2, fall back to WebGL1 if context creation fails.
  let webgl;
  try {
    webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (e) {
    try {
      // Force a WebGL1 context explicitly for older / restricted browsers.
      const ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!ctx) throw new Error('no webgl');
      webgl = new THREE.WebGLRenderer({ canvas, context: ctx, antialias: false });
    } catch (e2) {
      throw new Error('WebGL is not supported or is disabled in this browser. Please enable hardware acceleration.');
    }
  }
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    console.warn('WebGL context lost — reload the page to restore the 3D view.');
  });
  webgl.setPixelRatio(window.devicePixelRatio);
  webgl.setSize(canvas.clientWidth, canvas.clientHeight);

  const css2d = new CSS2DRenderer();
  css2d.setSize(canvas.clientWidth, canvas.clientHeight);
  css2d.domElement.style.position = 'absolute';
  css2d.domElement.style.top      = '0';
  css2d.domElement.style.pointerEvents = 'none';
  labelContainer.appendChild(css2d.domElement);

  // ── Lights ────────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(5, 10, 7);
  scene.add(dir);

  // ── Controls ──────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // ── Scene objects (cleared on each render call) ───────────────────────────
  let sceneGroup = null;

  // ── Resize observer ───────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    webgl.setSize(w, h);
    css2d.setSize(w, h);
  });
  ro.observe(canvas);

  // ── Animation loop ────────────────────────────────────────────────────────
  let animId = null;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    webgl.render(scene, camera);
    css2d.render(scene, camera);
  }
  animate();

  // ── Default camera position (saved for reset) ─────────────────────────────
  const defaultCameraPos = camera.position.clone();

  // ─────────────────────────────────────────────────────────────────────────
  // Public methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Rebuild the scene from a StitchGraph.
   *
   * @param {import('./model.js').StitchGraph} graph
   * @param {{ showNodes, showEdges, showLabels, showRoundLabels }} options
   */
  function render(graph, options = {}) {
    const {
      showNodes       = true,
      showEdges       = true,
      showLabels      = false,
      showRoundLabels = false,
    } = options;

    // Clear previous scene objects
    if (sceneGroup) {
      scene.remove(sceneGroup);
      disposeGroup(sceneGroup);
    }
    sceneGroup = new THREE.Group();

    // ── Node spheres ────────────────────────────────────────────────────────
    if (showNodes) {
      // One shared geometry for all node spheres; disposed via disposeGroup
      const geomNode = new THREE.SphereGeometry(NODE_RADIUS, 8, 6);
      sceneGroup.userData._sharedGeoms = [geomNode];
      for (const stitch of graph.allStitches) {
        const mat = new THREE.MeshLambertMaterial({ color: nodeColor(stitch.type) });
        const mesh = new THREE.Mesh(geomNode, mat);
        mesh.position.set(stitch.position.x, stitch.position.y, stitch.position.z);
        mesh.userData.stitch = stitch;
        sceneGroup.add(mesh);

        if (showLabels) {
          const div = document.createElement('div');
          div.className = 'stitch-label';
          div.textContent = stitch.label;
          const label = new CSS2DObject(div);
          label.position.set(stitch.position.x, stitch.position.y + NODE_RADIUS * 2, stitch.position.z);
          sceneGroup.add(label);
        }
      }
    }

    // ── Edges ────────────────────────────────────────────────────────────────
    if (showEdges) {
      for (const { a, b, kind } of graph.edges) {
        const color = kind === 'parent' ? COLORS.edgeParent : COLORS.edgeNeighbor;
        const line = buildLine(a.position, b.position, color);
        sceneGroup.add(line);
      }
    }

    // ── Round labels (one label per round at the centroid) ───────────────────
    if (showRoundLabels) {
      for (let ri = 0; ri < graph.rounds.length; ri++) {
        const round = graph.rounds[ri];
        if (round.length === 0) continue;
        const cx = round.reduce((s, st) => s + st.position.x, 0) / round.length;
        const cy = round.reduce((s, st) => s + st.position.y, 0) / round.length;
        const cz = round.reduce((s, st) => s + st.position.z, 0) / round.length;
        const maxR = Math.max(...round.map(st => Math.hypot(st.position.x - cx, st.position.z - cz)));

        const div = document.createElement('div');
        div.className = 'round-label';
        div.textContent = `R${ri + 1} (${round.length}st)`;
        const label = new CSS2DObject(div);
        label.position.set(cx + maxR + 0.3, cy, cz);
        sceneGroup.add(label);
      }
    }

    scene.add(sceneGroup);

    // Auto-fit camera to the graph bounding box
    fitCamera(graph, camera, controls);
  }

  function resetCamera() {
    camera.position.copy(defaultCameraPos);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  function dispose() {
    cancelAnimationFrame(animId);
    ro.disconnect();
    controls.dispose();
    webgl.dispose();
    if (css2d.domElement.parentNode) css2d.domElement.parentNode.removeChild(css2d.domElement);
    if (sceneGroup) disposeGroup(sceneGroup);
  }

  return { render, resetCamera, dispose };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function nodeColor(type) {
  switch (type) {
    case StitchType.MR:  return COLORS.nodeMR;
    case StitchType.SC:  return COLORS.nodeSC;
    case StitchType.INC: return COLORS.nodeINC;
    case StitchType.DEC: return COLORS.nodeDEC;
    default:             return COLORS.nodeSC;
  }
}

function buildLine(posA, posB, color) {
  const pts = [
    new THREE.Vector3(posA.x, posA.y, posA.z),
    new THREE.Vector3(posB.x, posB.y, posB.z),
  ];
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat  = new THREE.LineBasicMaterial({ color });
  return new THREE.Line(geom, mat);
}

/**
 * Fit camera so the whole model is visible.
 * Uses the bounding sphere of all stitch positions.
 */
function fitCamera(graph, camera, controls) {
  if (graph.allStitches.length === 0) return;

  // Compute bounding sphere
  const positions = graph.allStitches.map(s => new THREE.Vector3(s.position.x, s.position.y, s.position.z));
  const box = new THREE.Box3();
  for (const p of positions) box.expandByPoint(p);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  const fov = camera.fov * (Math.PI / 180);
  const dist = (sphere.radius * 1.8) / Math.tan(fov / 2);

  camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + dist);
  controls.target.copy(sphere.center);
  controls.update();
}

/** Recursively dispose Three.js geometries and materials, including shared geometries. */
function disposeGroup(group) {
  // Dispose any shared geometries stored by the render function
  if (group.userData._sharedGeoms) {
    for (const g of group.userData._sharedGeoms) g.dispose();
  }
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}
