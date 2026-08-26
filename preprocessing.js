"use strict";

(function exposePreprocessing(root) {
  const FILTER_COUNT = 5;
  const EPSILON = 1e-6;
  const SG_WEIGHTS = [
    [0.6606060606060596, 0.3818181818181823, 0.1636363636363636, 0.006060606060606165, -0.09090909090909068, -0.12727272727272707, -0.10303030303030293, -0.018181818181818254, 0.12727272727272695],
    [0.38181818181818133, 0.2787878787878788, 0.19090909090909092, 0.11818181818181825, 0.06060606060606078, 0.018181818181818316, -0.009090909090908988, -0.021212121212121245, -0.01818181818181837],
    [0.1636363636363635, 0.19090909090909064, 0.20086580086580091, 0.19350649350649354, 0.16883116883116897, 0.12683982683982692, 0.06753246753246764, -0.009090909090909097, -0.10303030303030311],
    [0.00606060606060619, 0.11818181818181772, 0.19350649350649357, 0.23203463203463204, 0.23376623376623384, 0.1987012987012987, 0.12683982683982692, 0.0181818181818182, -0.12727272727272732],
    [-0.0909090909090906, 0.06060606060606011, 0.1688311688311689, 0.23376623376623373, 0.2554112554112554, 0.23376623376623368, 0.16883116883116892, 0.060606060606060635, -0.09090909090909083],
    [-0.12727272727272684, 0.01818181818181779, 0.12683982683982686, 0.19870129870129855, 0.23376623376623384, 0.23203463203463193, 0.19350649350649354, 0.11818181818181822, 0.0060606060606062245],
    [-0.10303030303030244, -0.009090909090909302, 0.06753246753246757, 0.12683982683982667, 0.16883116883116886, 0.19350649350649324, 0.20086580086580094, 0.19090909090909094, 0.16363636363636364],
    [-0.018181818181817765, -0.021212121212121, -0.009090909090909174, 0.018181818181817862, 0.06060606060606071, 0.11818181818181812, 0.19090909090909092, 0.2787878787878788, 0.38181818181818183],
    [0.12727272727272743, -0.018181818181817522, -0.10303030303030314, -0.12727272727272787, -0.09090909090909083, 0.006060606060605878, 0.16363636363636358, 0.38181818181818183, 0.6606060606060606],
  ];

  function median(values) {
    const sorted = Array.from(values).sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function argmax(values) {
    let best = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] > values[best]) best = index;
    }
    return best;
  }

  function roundHalfToEven(value) {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction < 0.5) return floor;
    if (fraction > 0.5) return floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  function reflectIndex(index, length) {
    let output = index;
    while (output < 0 || output >= length) {
      output = output < 0 ? -output : (2 * length - 2 - output);
    }
    return output;
  }

  function movingAverage(values, window = 9) {
    const padding = Math.floor(window / 2);
    const output = new Float64Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
      let total = 0;
      for (let offset = -padding; offset <= padding; offset += 1) {
        total += values[reflectIndex(index + offset, values.length)];
      }
      output[index] = total / window;
    }
    return output;
  }

  function makeEdgeScore(values) {
    const smoothed = movingAverage(values, 9);
    const center = median(smoothed);
    const deviations = Array.from(smoothed, (value) => Math.abs(value - center));
    const scale = Math.max(median(deviations) * 1.4826, EPSILON);
    const raw = new Float64Array(smoothed.length - 1);
    for (let index = 0; index < raw.length; index += 1) {
      raw[index] = Math.abs((smoothed[index + 1] - smoothed[index]) / scale);
    }
    const output = new Float64Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      let total = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const source = index + offset;
        if (source >= 0 && source < raw.length) total += raw[source];
      }
      output[index] = total / 5;
    }
    return output;
  }

  function candidateBoundaries(edgeScore, limit = 28, nmsDistance = 4) {
    const maxima = [];
    for (let index = 0; index < edgeScore.length; index += 1) {
      const left = index === 0 ? edgeScore[0] : edgeScore[index - 1];
      const right = index === edgeScore.length - 1 ? edgeScore[index] : edgeScore[index + 1];
      if (edgeScore[index] >= left && edgeScore[index] >= right) maxima.push(index);
    }
    maxima.sort((left, right) => edgeScore[right] - edgeScore[left]);
    const selected = [];
    for (const candidate of maxima) {
      if (selected.every((previous) => Math.abs(candidate - previous) >= nmsDistance)) {
        selected.push(candidate);
      }
      if (selected.length >= limit) break;
    }
    return selected.sort((left, right) => left - right);
  }

  function bestBoundaryPath(candidates, edgeScore) {
    const minimumGap = 18;
    const maximumGap = 50;
    const minimumPeriod = 145;
    const maximumPeriod = 195;
    const expectedPeriod = 169;
    const scale = median(edgeScore) + EPSILON;
    let bestScore = -Infinity;
    let bestPath = null;

    function search(path, nextIndex) {
      if (path.length === FILTER_COUNT + 1) {
        const period = path[path.length - 1] - path[0];
        if (period < minimumPeriod || period > maximumPeriod) return;
        const gaps = path.slice(1).map((value, index) => value - path[index]);
        const meanGap = gaps.reduce((total, value) => total + value, 0) / gaps.length;
        const variance = gaps.reduce((total, value) => total + (value - meanGap) ** 2, 0) / gaps.length;
        const strength = path.reduce((total, value) => total + Math.log1p(edgeScore[value] / scale), 0);
        const regularityPenalty = 1.3 * Math.sqrt(variance) / Math.max(meanGap, EPSILON);
        const periodPenalty = 0.4 * Math.abs(period - expectedPeriod) / Math.max(expectedPeriod * 0.14, 1);
        const score = strength - regularityPenalty - periodPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestPath = path.slice();
        }
        return;
      }

      const last = path[path.length - 1];
      for (let index = nextIndex; index < candidates.length; index += 1) {
        const gap = candidates[index] - last;
        if (gap < minimumGap) continue;
        if (gap > maximumGap) break;
        if (path.length === FILTER_COUNT) {
          const period = candidates[index] - path[0];
          if (period < minimumPeriod || period > maximumPeriod) continue;
        }
        search([...path, candidates[index]], index + 1);
      }
    }

    for (let index = 0; index < candidates.length; index += 1) search([candidates[index]], index + 1);
    return bestPath;
  }

  function gridFallback(edgeScore) {
    const minimumPeriod = 145;
    const maximumPeriod = 195;
    const expectedPeriod = 169;
    let bestScore = -Infinity;
    let bestPath = null;
    for (let period = minimumPeriod; period <= maximumPeriod; period += 1) {
      for (let start = 0; start < edgeScore.length - period; start += 1) {
        const path = [];
        for (let filter = 0; filter <= FILTER_COUNT; filter += 1) {
          const boundary = start + roundHalfToEven(filter * period / FILTER_COUNT);
          const low = Math.max(0, boundary - 7);
          const high = Math.min(edgeScore.length, boundary + 8);
          path.push(low + argmax(edgeScore.slice(low, high)));
        }
        if (new Set(path).size !== FILTER_COUNT + 1) continue;
        if (path.slice(1).some((value, index) => value <= path[index])) continue;
        let score = path.reduce((total, value) => total + Math.log1p(edgeScore[value]), 0);
        score -= 0.2 * Math.abs(period - expectedPeriod) / Math.max(expectedPeriod * 0.14, 1);
        if (score > bestScore) {
          bestScore = score;
          bestPath = path;
        }
      }
    }
    return bestPath;
  }

  function matchSecondaryBoundaries(referencePath, edgeScore) {
    const scale = median(edgeScore) + EPSILON;
    const lagScores = [];
    for (let lag = -12; lag <= 12; lag += 1) {
      const values = referencePath
        .filter((boundary) => boundary + lag >= 0 && boundary + lag < edgeScore.length)
        .map((boundary) => Math.log1p(edgeScore[boundary + lag] / scale));
      lagScores.push(values.length >= FILTER_COUNT
        ? values.reduce((total, value) => total + value, 0) / values.length
        : -Infinity);
    }
    const globalLag = argmax(lagScores) - 12;
    const matched = referencePath.map((boundary) => {
      const predicted = Math.max(0, Math.min(edgeScore.length - 1, boundary + globalLag));
      const low = Math.max(0, predicted - 2);
      const high = Math.min(edgeScore.length, predicted + 3);
      return low + argmax(edgeScore.slice(low, high));
    });
    if (matched.slice(1).some((value, index) => value <= matched[index])) {
      throw new Error("CH2 边界匹配结果不是严格递增序列");
    }
    return matched;
  }

  function trimSegment(values, start, end) {
    const trim = Math.max(1, roundHalfToEven((end - start) * 0.15));
    if (end - trim - (start + trim) < 4) throw new Error(`滤光片分段过短：${start}:${end}`);
    return values.slice(start + trim, end - trim);
  }

  function resampleSegment(values, outputLength) {
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * (values.length - 1) / (outputLength - 1);
      const left = Math.floor(position);
      const right = Math.min(values.length - 1, left + 1);
      const fraction = position - left;
      output[index] = values[left] * (1 - fraction) + values[right] * fraction;
    }
    return output;
  }

  function alignFilterCycle(ch2Input, ch3Input, outputLength = 224) {
    if (ch2Input.length !== ch3Input.length || ch2Input.length <= 195) {
      throw new Error("CH2/CH3 必须长度相同，且至少包含 196 个点");
    }
    const ch2 = Float64Array.from(ch2Input);
    const ch3 = Float64Array.from(ch3Input);
    const ch3Edge = makeEdgeScore(ch3);
    const candidates = candidateBoundaries(ch3Edge);
    const ch3Path = bestBoundaryPath(candidates, ch3Edge) || gridFallback(ch3Edge);
    if (!ch3Path) throw new Error("无法定位一个完整周期的 6 个滤光片切换边界");
    const ch2Path = matchSecondaryBoundaries(ch3Path, makeEdgeScore(ch2));
    const ch2Segments = [];
    const ch3Segments = [];
    const anchorScores = [];
    for (let index = 0; index < FILTER_COUNT; index += 1) {
      ch2Segments.push(trimSegment(ch2, ch2Path[index], ch2Path[index + 1]));
      const segment3 = trimSegment(ch3, ch3Path[index], ch3Path[index + 1]);
      ch3Segments.push(segment3);
      anchorScores.push(median(segment3));
    }
    const anchorIndex = argmax(anchorScores);
    const base = Math.floor(outputLength / FILTER_COUNT);
    const remainder = outputLength % FILTER_COUNT;
    const alignedLengths = Array.from({ length: FILTER_COUNT }, (_, index) => base + (index < remainder ? 1 : 0));
    const alignedCh2 = new Float32Array(outputLength);
    const alignedCh3 = new Float32Array(outputLength);
    let writeOffset = 0;
    for (let index = 0; index < FILTER_COUNT; index += 1) {
      const sourceIndex = (anchorIndex + index) % FILTER_COUNT;
      const segment2 = resampleSegment(ch2Segments[sourceIndex], alignedLengths[index]);
      const segment3 = resampleSegment(ch3Segments[sourceIndex], alignedLengths[index]);
      alignedCh2.set(segment2, writeOffset);
      alignedCh3.set(segment3, writeOffset);
      writeOffset += alignedLengths[index];
    }
    return {
      alignedCh2,
      alignedCh3,
      boundaries: ch3Path,
      ch2Boundaries: ch2Path,
      periodSamples: ch3Path[ch3Path.length - 1] - ch3Path[0],
      anchorOriginalIndex: anchorIndex,
      alignedFilterLengths: alignedLengths,
    };
  }

  function savgolSegment(values) {
    const output = new Float32Array(values.length);
    const lastWindowStart = values.length - 9;
    for (let index = 0; index < values.length; index += 1) {
      let weights;
      let sourceStart;
      if (index < 4) {
        weights = SG_WEIGHTS[index];
        sourceStart = 0;
      } else if (index >= values.length - 4) {
        weights = SG_WEIGHTS[index - lastWindowStart];
        sourceStart = lastWindowStart;
      } else {
        weights = SG_WEIGHTS[4];
        sourceStart = index - 4;
      }
      let total = 0;
      for (let offset = 0; offset < 9; offset += 1) total += weights[offset] * values[sourceStart + offset];
      output[index] = total;
    }
    return output;
  }

  function smoothAligned(values, filterLengths) {
    const output = new Float32Array(values.length);
    let offset = 0;
    for (const length of filterLengths) {
      output.set(savgolSegment(values.slice(offset, offset + length)), offset);
      offset += length;
    }
    return output;
  }

  function buildFeatures(ch2, ch3) {
    const output = new Float32Array(ch2.length * 6);
    for (let index = 0; index < ch2.length; index += 1) {
      const previous = index === 0 ? ch2.length - 1 : index - 1;
      const safeCh2 = Math.max(ch2[index] + EPSILON, EPSILON);
      const safeCh3 = Math.max(ch3[index] + EPSILON, EPSILON);
      const denominator = Math.max(ch3[index] + ch2[index] + EPSILON, EPSILON);
      const offset = index * 6;
      output[offset] = ch2[index];
      output[offset + 1] = ch3[index];
      output[offset + 2] = Math.log(safeCh3 / safeCh2);
      output[offset + 3] = (ch3[index] - ch2[index]) / denominator;
      output[offset + 4] = ch2[index] - ch2[previous];
      output[offset + 5] = ch3[index] - ch3[previous];
    }
    return output;
  }

  function prepareFeatures(samples, outputLength = 224) {
    if (samples.length !== outputLength) throw new Error(`每轮必须恰好包含 ${outputLength} 个有效点`);
    const alignment = alignFilterCycle(
      samples.map((sample) => sample.ch2),
      samples.map((sample) => sample.ch3),
      outputLength,
    );
    const ch2 = smoothAligned(alignment.alignedCh2, alignment.alignedFilterLengths);
    const ch3 = smoothAligned(alignment.alignedCh3, alignment.alignedFilterLengths);
    return { features: buildFeatures(ch2, ch3), alignment };
  }

  const api = { alignFilterCycle, prepareFeatures, smoothAligned, buildFeatures };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NIRPreprocessing = api;
}(typeof globalThis !== "undefined" ? globalThis : window));
