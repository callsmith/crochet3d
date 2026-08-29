/**
 * geometry.js — 3D Position Computation
 *
 * Assigns a world-space position (x, y, z) to each stitch in the graph.
 * This module knows about 3D math but nothing about crochet parsing/building.
 *
 * ─── Algorithm overview ──────────────────────────────────────────────────────
 *
 * The old layout forced every round onto a perfect circle, which erased
 * localized increases/decreases.  The current layout is parent-driven:
 *
 *   1. Place the foundation ring on a circle.
 *   2. For each later round, place every stitch outward from the average of
 *      its parent stitch positions, using stitch height as the desired
 *      parent→child edge length.
 *   3. Relax same-round neighbor distances so the round closes smoothly while
 *      retaining local deformations from the parent topology.
 *   4. Blend the average radius toward a stuffed / barrel profile without
 *      forcing the round back into a perfect circle.
 */

import { StitchType, getStitchGeometry } from './model.js';

const STITCH_WIDTH_SCALE = 0.8;
const MIN_CIRCUMFERENCE = getStitchGeometry(StitchType.SC).width * STITCH_WIDTH_SCALE;
const ROUND_RELAX_ITERATIONS = 48;
const TETHER_PULL = 0.16;
const TARGET_RADIUS_PULL = 0.12;
// Keep most of the parent→child edge vertical while leaving enough planar run
// for the round to expand and show localized shaping.
const VERTICAL_STEP_BASE = 0.82;
const VERTICAL_STEP_STUFFING_REDUCTION = 0.14;
// When the vertical step would exceed the stitch height, retain a small planar
// component so coincident parent/child columns can still spread into a round.
const PLANAR_FALLBACK_RATIO = 0.2;
const FINAL_RADIUS_CORRECTION_THRESHOLD = 0.1;
const FINAL_RADIUS_CORRECTION_PULL = 0.35;
const MIN_DIRECTION_LENGTH = 1e-5;

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

  // Natural radius for each round (sum of nominal stitch widths / 2π)
  const naturalRadii = rounds.map(round => {
   const circumference = round.reduce((sum, stitch) => {
     return sum + getStitchGeometry(stitch.type).width * STITCH_WIDTH_SCALE;
   }, 0);
   return Math.max(circumference, MIN_CIRCUMFERENCE) / (2 * Math.PI);
  });

  // Barrel radius = max natural radius across all rounds
  const maxRadius = Math.max(...naturalRadii);

  // Effective radius per round blends natural ↔ barrel
  const effectiveRadii = naturalRadii.map(r => r * (1 - stuffing) + maxRadius * stuffing);

  layoutFoundationRound(rounds[0], effectiveRadii[0]);

  let currentY = 0;
  for (let ri = 1; ri < numRounds; ri++) {
   const round = rounds[ri];
   const prevRound = rounds[ri - 1];
   if (round.length === 0) continue;

   const avgHeight = average(round.map(stitch => getStitchGeometry(stitch.type).height));
   const verticalStep = avgHeight * (VERTICAL_STEP_BASE - stuffing * VERTICAL_STEP_STUFFING_REDUCTION);
   currentY += verticalStep;

   const relaxed = layoutRoundFromParents(round, prevRound, effectiveRadii[ri], verticalStep, stuffing);
   for (let si = 0; si < round.length; si++) {
     round[si].position = {
       x: relaxed[si].x,
       y: currentY,
       z: relaxed[si].z,
     };
   }
  }

  normalizeScaleToStitchHeights(graph);
  centerVertically(graph);
}

function layoutFoundationRound(round, radius) {
  const n = round.length;
  if (n === 0) return;

  for (let si = 0; si < n; si++) {
   const theta = (2 * Math.PI * si) / n;
   round[si].position = {
     x: radius * Math.cos(theta),
     y: 0,
     z: radius * Math.sin(theta),
   };
  }
}

function layoutRoundFromParents(round, prevRound, targetRadius, verticalStep, stuffing) {
  const prevCentroid = computeCentroid(prevRound);
  const anchors = round.map((stitch, index) => {
   const parentCenter = averageParentPosition(stitch, prevRound, index);
   const direction = outwardDirection(parentCenter, prevCentroid, round.length, index);
   const targetHeight = getStitchGeometry(stitch.type).height;
   const planarSquared = targetHeight ** 2 - verticalStep ** 2;
   const planarOffset = Math.sqrt(planarSquared > 0 ? planarSquared : targetHeight ** 2 * PLANAR_FALLBACK_RATIO);
   return {
     x: parentCenter.x + direction.x * planarOffset,
     z: parentCenter.z + direction.z * planarOffset,
   };
  });

  const points = anchors.map(anchor => ({ ...anchor }));
  const desiredNeighborDistances = round.map((stitch, index) => {
   const next = round[(index + 1) % round.length];
   const a = getStitchGeometry(stitch.type).width;
   const b = getStitchGeometry(next.type).width;
   return ((a + b) * 0.5) * STITCH_WIDTH_SCALE;
  });

  for (let iter = 0; iter < ROUND_RELAX_ITERATIONS; iter++) {
   for (let i = 0; i < points.length; i++) {
     points[i].x += (anchors[i].x - points[i].x) * TETHER_PULL;
     points[i].z += (anchors[i].z - points[i].z) * TETHER_PULL;
   }

   for (let i = 0; i < points.length; i++) {
     const j = (i + 1) % points.length;
     relaxPair(points[i], points[j], desiredNeighborDistances[i], i + 0.5, points.length);
   }

   const centroid = computeCentroid(points);
   const avgRadius = average(points.map(p => distance2d(p, centroid)));
   if (avgRadius > MIN_DIRECTION_LENGTH) {
     const pull = TARGET_RADIUS_PULL + stuffing * 0.08;
     const scale = 1 + ((targetRadius - avgRadius) / avgRadius) * pull;
     for (const point of points) {
       point.x = centroid.x + (point.x - centroid.x) * scale;
       point.z = centroid.z + (point.z - centroid.z) * scale;
     }
   }
  }

  const centroid = computeCentroid(points);
  const avgRadius = average(points.map(p => distance2d(p, centroid)));
  if (avgRadius > MIN_DIRECTION_LENGTH) {
   const radiusError = Math.abs(targetRadius - avgRadius) / avgRadius;
   if (radiusError <= FINAL_RADIUS_CORRECTION_THRESHOLD) return points;

   const finalScale = 1 + ((targetRadius - avgRadius) / avgRadius) * FINAL_RADIUS_CORRECTION_PULL;
   for (const point of points) {
     point.x = centroid.x + (point.x - centroid.x) * finalScale;
     point.z = centroid.z + (point.z - centroid.z) * finalScale;
   }
  }

  return points;
}

function averageParentPosition(stitch, prevRound, fallbackIndex) {
  const parents = stitch.parents.length ? stitch.parents : [prevRound[fallbackIndex % prevRound.length]];
  const sum = parents.reduce((acc, parent) => {
   acc.x += parent.position.x;
   acc.z += parent.position.z;
   return acc;
  }, { x: 0, z: 0 });

  return {
   x: sum.x / parents.length,
   z: sum.z / parents.length,
  };
}

function outwardDirection(point, centroid, count, index) {
  const dx = point.x - centroid.x;
  const dz = point.z - centroid.z;
  const len = Math.hypot(dx, dz);
  if (len > MIN_DIRECTION_LENGTH) {
   return { x: dx / len, z: dz / len };
  }

  const theta = (2 * Math.PI * index) / Math.max(count, 1);
  return { x: Math.cos(theta), z: Math.sin(theta) };
}

function relaxPair(a, b, targetDistance, fallbackAngleIndex, fallbackAngleCount) {
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  let dist = Math.hypot(dx, dz);

  if (dist < MIN_DIRECTION_LENGTH) {
   const fallbackAngle = (2 * Math.PI * fallbackAngleIndex) / Math.max(fallbackAngleCount, 1);
   dx = Math.cos(fallbackAngle) * MIN_DIRECTION_LENGTH;
   dz = Math.sin(fallbackAngle) * MIN_DIRECTION_LENGTH;
   dist = MIN_DIRECTION_LENGTH;
  }

  const correction = ((targetDistance - dist) / dist) * 0.5;
  a.x -= dx * correction;
  a.z -= dz * correction;
  b.x += dx * correction;
  b.z += dz * correction;
}

function computeCentroid(points) {
  if (points.length === 0) return { x: 0, z: 0 };

  const sum = points.reduce((acc, point) => {
   acc.x += point.x;
   acc.z += point.z;
   return acc;
  }, { x: 0, z: 0 });

  return {
   x: sum.x / points.length,
   z: sum.z / points.length,
  };
}

function normalizeScaleToStitchHeights(graph) {
  const ratios = [];

  for (const stitch of graph.allStitches) {
   const target = getStitchGeometry(stitch.type).height;
   if (target <= 0) continue;

   for (const parent of stitch.parents) {
     const actual = Math.hypot(
       stitch.position.x - parent.position.x,
       stitch.position.y - parent.position.y,
       stitch.position.z - parent.position.z,
     );
     if (actual > MIN_DIRECTION_LENGTH) {
       ratios.push(actual / target);
     }
   }
  }

  if (ratios.length === 0) return;

  ratios.sort((a, b) => a - b);
  const medianRatio = ratios[Math.floor(ratios.length / 2)];
  if (medianRatio <= MIN_DIRECTION_LENGTH) return;

  const scale = 1 / medianRatio;
  for (const stitch of graph.allStitches) {
   stitch.position.x *= scale;
   stitch.position.y *= scale;
   stitch.position.z *= scale;
  }
}

function centerVertically(graph) {
  const ys = graph.allStitches.map(stitch => stitch.position.y);
  if (ys.length === 0) return;

  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const midY = (minY + maxY) / 2;

  for (const stitch of graph.allStitches) {
   stitch.position.y -= midY;
  }
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
