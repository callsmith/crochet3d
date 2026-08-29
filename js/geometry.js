/**
 * geometry.js — 3D Position Computation
 *
 * Assigns a world-space position (x, y, z) to each stitch in the graph.
 * This module knows about 3D math but nothing about crochet parsing/building.
 *
 * ─── Algorithm overview ──────────────────────────────────────────────────────
 *
 * Rounds are stacked along the Y axis.
 * Within each round, stitches are placed around a circle in the XZ plane.
 * The circle radius for round i is derived from the stitch count for that
 * round: r = stitchCount / (2π) scaled by STITCH_SPACING.
 *
 * The angular position of each stitch preserves the worked order, so
 * localized increases/decreases remain spatially localized.  A stitch at
 * index k in a round of N stitches is placed at angle:
 *
 *   θ = 2π * k / N  (in radians)
 *
 * ─── Stuffing Factor ─────────────────────────────────────────────────────────
 *
 * Without stuffing, the Y coordinate for each round is set proportional to its
 * round index, producing a flat cylinder.  With a stuffing factor (0–1), the
 * Y coordinates are stretched so that the shape inflates outward.  The exact
 * model is: the radius at each round is blended between the "natural" radius
 * (based purely on stitch count) and a "barrel" profile (max radius clamped to
 * the peak stitch count):
 *
 *   effectiveRadius = naturalRadius * (1 - stuffing)
 *                   + barrelRadius  *  stuffing
 *
 * where barrelRadius uses the maximum stitch count across all rounds.
 *
 * The Y spacing between rounds is also scaled so a highly stuffed object looks
 * rounder rather than stretched.
 *
 * ─── Angular offset ──────────────────────────────────────────────────────────
 *
 * To make parent-child edges less visually overlapping, each round is rotated
 * by half a stitch-spacing relative to the previous round.  This small angular
 * offset makes the structure look like alternating brick courses, matching real
 * amigurumi topology.
 *
 * ─── Localized INC/DEC contouring ────────────────────────────────────────────
 *
 * Because stitches are placed in exact worked order with angles proportional to
 * their index, any localized cluster of INC or DEC stitches naturally crowds
 * together in that arc of the circle, pulling the shape outward (INC) or
 * inward (DEC) in that region.  This emerges from the topology without extra
 * computation.
 */

const STITCH_SPACING = 0.35;  // world-units per stitch along the circumference

/**
 * Compute 3D positions for every stitch in the graph.
 * Mutates stitch.position in place.
 *
 * @param {import('./model.js').StitchGraph} graph
 * @param {number} stuffing  0.0 (flat) … 1.0 (fully inflated)
 */
export function computePositions(graph, stuffing = 0.5) {
  const rounds = graph.rounds;
  if (rounds.length === 0) return;

  const numRounds = rounds.length;

  // Natural radius for each round (circumference / 2π)
  const naturalRadii = rounds.map(r => Math.max(r.length, 1) * STITCH_SPACING / (2 * Math.PI));

  // Barrel radius = max natural radius across all rounds
  const maxRadius = Math.max(...naturalRadii);

  // Effective radius per round blends natural ↔ barrel
  const effectiveRadii = naturalRadii.map(r => r * (1 - stuffing) + maxRadius * stuffing);

  // Y spacing between rounds — compress as stuffing increases so we get a
  // rounder silhouette rather than an elongated barrel
  const baseSpacing = STITCH_SPACING * 1.2;
  const ySpacing = baseSpacing * (1 - stuffing * 0.5);

  // Cumulative angular offset across rounds (alternating brick course effect)
  let cumulativeAngle = 0;

  for (let ri = 0; ri < numRounds; ri++) {
    const round = rounds[ri];
    const n = round.length;
    if (n === 0) continue;

    const radius = effectiveRadii[ri];
    const y = ri * ySpacing;

    // Rotate each round by half a stitch increment relative to the last round
    cumulativeAngle += Math.PI / Math.max(n, 1);

    for (let si = 0; si < n; si++) {
      const stitch = round[si];
      const theta = cumulativeAngle + (2 * Math.PI * si) / n;

      stitch.position = {
        x: radius * Math.cos(theta),
        y,
        z: radius * Math.sin(theta),
      };
    }
  }

  // ── Centre the model vertically ────────────────────────────────────────────
  const totalHeight = (numRounds - 1) * ySpacing;
  const midY = totalHeight / 2;
  for (const stitch of graph.allStitches) {
    stitch.position.y -= midY;
  }
}
