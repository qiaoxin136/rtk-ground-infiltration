export type Bounds = ReadonlyArray<readonly [number, number]>;

/**
 * Deterministic PRNG (Mulberry32) so calibration is 100% reproducible across local & cloud runs.
 */
export function createRng(seed = 42): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampToBounds(x: number[], bounds: Bounds): void {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < bounds[i][0]) x[i] = bounds[i][0];
    else if (x[i] > bounds[i][1]) x[i] = bounds[i][1];
  }
}

/**
 * Fast bounded Hooke-Jeeves pattern search for local polishing (analogous to L-BFGS-B polish).
 */
export function boundedPatternSearch(
  fn: (x: readonly number[]) => number,
  x0: readonly number[],
  bounds: Bounds,
  maxSteps = 90
): { x: number[]; fx: number } {
  const dim = x0.length;
  const x = x0.slice();
  clampToBounds(x, bounds);
  let bestFx = fn(x);

  const stepSizes = bounds.map(([lo, hi]) => 0.08 * (hi - lo));
  const minStepSizes = bounds.map(([lo, hi]) => 1e-4 * (hi - lo));
  const candidate = x.slice();

  for (let iter = 0; iter < maxSteps; iter++) {
    let improved = false;
    for (let d = 0; d < dim; d++) {
      const h = stepSizes[d];
      if (h <= minStepSizes[d]) continue;
      const orig = x[d];

      // Try +h
      const up = Math.min(bounds[d][1], orig + h);
      if (up !== orig) {
        candidate[d] = up;
        const fUp = fn(candidate);
        if (fUp < bestFx) {
          bestFx = fUp;
          x[d] = up;
          improved = true;
          continue;
        }
      }

      // Try -h
      const dn = Math.max(bounds[d][0], orig - h);
      if (dn !== orig) {
        candidate[d] = dn;
        const fDn = fn(candidate);
        if (fDn < bestFx) {
          bestFx = fDn;
          x[d] = dn;
          improved = true;
          continue;
        }
      }

      candidate[d] = orig;
    }

    if (!improved) {
      let anyAboveMin = false;
      for (let d = 0; d < dim; d++) {
        stepSizes[d] *= 0.5;
        if (stepSizes[d] > minStepSizes[d]) anyAboveMin = true;
      }
      if (!anyAboveMin) break;
    }
  }

  return { x, fx: bestFx };
}

/**
 * Differential Evolution (DE/best/1/bin with dither + local pattern-search polish)
 * matching SciPy's differential_evolution workflow for 20-parameter coupled RTK + ICM GIM calibration.
 */
export function differentialEvolution(
  fn: (x: readonly number[]) => number,
  bounds: Bounds,
  options: {
    maxIter?: number;
    popSizeMultiplier?: number;
    seed?: number;
    onProgress?: (iter: number, maxIter: number, bestFx: number) => void;
  } = {}
): { x: number[]; fx: number } {
  const dim = bounds.length;
  const maxIter = options.maxIter ?? 36;
  const popMult = options.popSizeMultiplier ?? 5;
  const popSize = Math.max(24, Math.min(110, dim * popMult));
  const rng = createRng(options.seed ?? 42);

  // Latin Hypercube initialization for thorough subsurface parameter coverage
  const pop: number[][] = Array.from({ length: popSize }, () => new Array<number>(dim));
  for (let d = 0; d < dim; d++) {
    const [lo, hi] = bounds[d];
    const span = hi - lo;
    const perm = Array.from({ length: popSize }, (_, i) => i);
    for (let i = popSize - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    for (let i = 0; i < popSize; i++) {
      pop[i][d] = lo + ((perm[i] + rng()) / popSize) * span;
    }
  }

  const fitness = new Float64Array(popSize);
  let bestIdx = 0;
  let bestFx = Infinity;

  for (let i = 0; i < popSize; i++) {
    const fx = fn(pop[i]);
    fitness[i] = fx;
    if (fx < bestFx) {
      bestFx = fx;
      bestIdx = i;
    }
  }

  const trial = new Array<number>(dim);
  const cr = 0.75;

  for (let gen = 0; gen < maxIter; gen++) {
    const fMut = 0.5 + 0.45 * rng(); // dither in [0.5, 0.95]

    for (let i = 0; i < popSize; i++) {
      let r1 = Math.floor(rng() * popSize);
      while (r1 === i) r1 = Math.floor(rng() * popSize);
      let r2 = Math.floor(rng() * popSize);
      while (r2 === i || r2 === r1) r2 = Math.floor(rng() * popSize);

      const jRand = Math.floor(rng() * dim);
      const bestVec = pop[bestIdx];
      const p1 = pop[r1];
      const p2 = pop[r2];
      const target = pop[i];

      for (let d = 0; d < dim; d++) {
        if (d === jRand || rng() < cr) {
          let v = bestVec[d] + fMut * (p1[d] - p2[d]);
          const [lo, hi] = bounds[d];
          if (v < lo) v = lo + 0.25 * rng() * (target[d] - lo);
          else if (v > hi) v = hi - 0.25 * rng() * (hi - target[d]);
          trial[d] = v;
        } else {
          trial[d] = target[d];
        }
      }

      const fTrial = fn(trial);
      if (fTrial <= fitness[i]) {
        for (let d = 0; d < dim; d++) target[d] = trial[d];
        fitness[i] = fTrial;
        if (fTrial < bestFx) {
          bestFx = fTrial;
          bestIdx = i;
        }
      }
    }

    options.onProgress?.(gen + 1, maxIter, bestFx);
  }

  // Final polish from global DE winner
  const polished = boundedPatternSearch(fn, pop[bestIdx], bounds, 120);
  return polished;
}
