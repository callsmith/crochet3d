/**
 * model.js — Stitch Graph Data Model
 *
 * The stitch graph is the canonical representation of a crochet pattern.
 * Every stitch is a node. Edges capture:
 *   - parent/child relationships (across rounds)
 *   - same-round neighbor relationships (prev/next within a round)
 *
 * No 3D geometry lives here. This module is purely topological.
 */

/**
 * Supported stitch types.
 * To add a new stitch type (HDC, DC, CH, SL, etc.) in the future,
 * add an entry here and handle it in builder.js.
 */
export const StitchType = {
  MR:  'MR',   // Magic Ring — foundation loop; creates the initial set of stitches
  SC:  'SC',   // Single Crochet — 1 parent → 1 child
  INC: 'INC',  // Increase — 1 parent → 2 children
  DEC: 'DEC',  // Decrease / SCTOG — 2 parents → 1 child
};

/**
 * A single stitch node in the stitch graph.
 *
 * Core fields (topology):
 *   id            — unique integer identifier (scoped to the owning StitchGraph)
 *   type          — StitchType value
 *   round         — 0-based round index
 *   indexInRound  — 0-based position within the round (worked order)
 *   parents       — stitches in the previous round that this stitch works into
 *   children      — stitches in the next round that work into this stitch
 *   prevInRound   — preceding stitch in the same round (circular)
 *   nextInRound   — following stitch in the same round (circular)
 *
 * Geometry field (populated by geometry.js):
 *   position      — { x, y, z } world position
 */
export class Stitch {
  constructor({ id, type, round, indexInRound }) {
    this.id           = id;
    this.type         = type;
    this.round        = round;
    this.indexInRound = indexInRound;

    this.parents     = [];   // Stitch[]
    this.children    = [];   // Stitch[]
    this.prevInRound = null; // Stitch | null
    this.nextInRound = null; // Stitch | null

    this.position = { x: 0, y: 0, z: 0 };
  }

  /** Human-readable label for debug display. */
  get label() {
    return `R${this.round + 1}S${this.indexInRound + 1}(${this.type})`;
  }
}

/**
 * The complete stitch graph for a parsed pattern.
 *
 * rounds[i]  — ordered array of Stitch nodes for round i (worked order).
 *
 * This object is the single source of truth that flows from the parser
 * through geometry computation to the renderer.
 */
export class StitchGraph {
  constructor() {
    this.rounds  = [];  // Stitch[][]
    this._nextId = 0;   // Per-instance ID counter — safe for concurrent graph builds
  }

  /**
   * Create a new Stitch owned by this graph.
   * Use this instead of `new Stitch(…)` directly so IDs remain unique per graph.
   */
  createStitch({ type, round, indexInRound }) {
    return new Stitch({ id: this._nextId++, type, round, indexInRound });
  }

  get totalStitches() {
    return this.rounds.reduce((s, r) => s + r.length, 0);
  }

  /** Flat list of every stitch in round-then-worked order. */
  get allStitches() {
    return this.rounds.flat();
  }

  /**
   * All graph edges as { a: Stitch, b: Stitch, kind } objects.
   * kind: 'parent' | 'neighbor'
   * Each undirected pair appears exactly once.
   */
  get edges() {
    const seen = new Set();
    const result = [];

    const add = (a, b, kind) => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ a, b, kind });
      }
    };

    for (const stitch of this.allStitches) {
      for (const parent of stitch.parents) {
        add(stitch, parent, 'parent');
      }
      if (stitch.nextInRound) {
        add(stitch, stitch.nextInRound, 'neighbor');
      }
    }

    return result;
  }
}
