"use strict";

const fs = require("fs");
const path = require("path");
const preprocessing = require(path.join(__dirname, "..", "preprocessing.js"));

const csvPath = process.argv[2];
if (!csvPath) throw new Error("Usage: node verify_preprocessing.js <csv-path>");
const lines = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
const headers = lines[0].split(",");
const sampleIndexColumn = headers.indexOf("sample_index");
const ch2Column = headers.indexOf("CH2_mV");
const ch3Column = headers.indexOf("CH3_mV");
const samples = lines.slice(1).map((line) => {
  const values = line.split(",");
  return {
    sampleIndex: Number(values[sampleIndexColumn]),
    ch2: Number(values[ch2Column]),
    ch3: Number(values[ch3Column]),
  };
}).sort((left, right) => left.sampleIndex - right.sampleIndex).slice(0, 224);
const result = preprocessing.prepareFeatures(samples, 224);
process.stdout.write(JSON.stringify({
  features: Array.from(result.features),
  boundaries: result.alignment.boundaries,
  ch2Boundaries: result.alignment.ch2Boundaries,
  periodSamples: result.alignment.periodSamples,
  anchorOriginalIndex: result.alignment.anchorOriginalIndex,
}));
