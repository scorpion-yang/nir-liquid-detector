# MoPod V5

Mobile-first static web app. Upload the **contents** of this directory to your GitHub Pages publishing directory. `index.html` must be at that directory's root. No build step is required. Keep `model/` beside `index.html`.

## Pages

- `#/home`: device status, the four approved application cards, Quick Scan.
- `#/quick`: real BLE concentration detection; fixed Start/Stop buttons; no duration input; 600-second maximum; dynamic time axis; CSV export.
- `#/history`: local records, date/type filters, record details, concentration summary, CSV export and confirmed deletion.
- `#/models`: five equally sized model entries. Tap an entry for details.
- `#/settings`: BLE device connection, screen wake lock, fixed 600-second limit, Demo Mode, auto-save, export/clear records, app information.
- `#/application/safety`, `food`, `pharma`, `water`: shared final-result card. No raw signal or concentration curve on these four pages.

Bottom navigation stays visible; only the middle content area scrolls. The interface is English. V4 was not changed.

## Running locally

From this directory run `python -m http.server 8765 --bind 127.0.0.1` and open `http://127.0.0.1:8765`. On a phone use your HTTPS GitHub Pages address in Android Chrome. A plain LAN HTTP address is not a secure context for Web Bluetooth.

The browser downloads ONNX Runtime Web 1.27.0 from jsDelivr; internet access is needed. The five bundled ONNX models are from V8 run `20260815_215317`, with the original CH3 alignment, per-segment SG smoothing, feature order and fold-specific normalization preserved.

## Real device behavior

- BLE ABF0 / ABF1 / ABF2 / ABF3 UUIDs and A5 command / 5A response framing match V12.
- Servo mode 360, speed 20%, per-round firmware duration 1500 ms.
- Each round requires unique, contiguous indices 0–223 with increasing ESP timestamps. Incomplete rounds fail; data are never padded.
- ADC STOP also stops the servo under V12. Each round restarts the ADC and servo. A short command settling interval lets the firmware sensor task observe STOP.
- LED remains on during acquisition and is turned off on termination. The next acquisition starts without waiting for previous inference. Model inferences are serialized because the WASM runtime does not support overlapping runs.
- Time coordinates use the approved nominal labels 1.5, 3.0, …, 600 s, not host wall-clock timestamps. Firmware and BLE overhead can make actual elapsed time differ. The 600-second host limit stops a run even if fewer than 400 rounds have completed.
- Screen wake lock is requested only during detection and only if the browser supports it. Background tabs/OS suspension may pause JavaScript; keep the tab in the foreground. V12 independently stops each 1500 ms round even when the page cannot send a stop.
- Battery, temperature and filter position are not transmitted by the existing protocol; no readings are fabricated.

## Demo and application models

Demo Mode is **off by default**. Enable it in Settings to preview the four application results. Demo samples are fixed, explicitly labeled examples. In a model's detail page, the Demo result selector previews all supported states. Quick Scan always uses real device data, including when the four application pages are in Demo Mode.

Safety / Food / Pharma / Water Quality application models have **not** been provided. They show unavailable/unknown results in live mode. The old 27-liquid classifier is not relabeled as a 31-liquid model. The concentration model does not imply support for ethanol vol% or ethylene-glycol vol%; quantitative application fields remain absent without separately validated support.

No hazard database is fabricated. A configured Safety adapter must provide verified hazard references matched to the predicted material, including composition validation for mixtures. Pharma states describe formulation deviation, not expiry, pharmacopoeial compliance, or therapeutic efficacy. Water results do not assert drinking-water or wastewater compliance.

### Application adapter interface

The integration object is `window.MoPod`. Register a validated application model:

```js
window.MoPod.registerApplication('food', async (samples, {signal}) => {
  // Run YOUR validated model on the 224 actual BLE samples.
  // Return a validated class, not a random value or storage-day rule.
  const output = await yourFreshnessModel(samples, {signal});
  return {sampleName: 'Apple', status: output.status, reliable: output.reliable};
}, {modelId: 'your-model-id', validationId: 'your-validation-reference'});
```

Valid status keys:

| Application | Keys |
| --- | --- |
| safety | `flammable`, `not_flammable`, `unknown`, `undetermined` |
| food | `fresh`, `intermediate`, `aged`, `unavailable` |
| pharma | `consistent`, `slight`, `significant`, `unavailable` |
| water | `no_target`, `detected`, `high`, `inconclusive` |

Safety registration also requires `liquidCount: 31`. Non-unknown Safety results require `hazard: {verified: true, referenceId, sampleName, sampleKind: 'pure'|'mixture', classification: 'flammable'|'not_flammable'}`; a mixture additionally needs `compositionValidationId`. Without this evidence, identity can remain visible but flammability is undetermined.

Water `high` requires `highThresholdValidationId`. Optional concentration uses `{value, unit:'vol%', analyte, validated:true, modelId, validationId}`; `analyte` must match the identified sample (Water: `Ethylene Glycol`), and values must be finite numbers from 0 to 100. These metadata fields describe upstream validation, not validation that the frontend can independently perform.

If an existing pipeline already supplies verified results, use:

```js
window.MoPod.updateApplicationResult('food', {
  sampleName: 'Apple', status: 'fresh', reliable: true,
  evidence: {modelId: 'your-model-id', validationId: 'your-validation-reference'}
});
window.MoPod.openApplication('food');
```

This updates the current result UI. Scan Again calls a registered provider, captures a new actual sample and saves the result when auto-save is enabled. Direct result updates do not automatically create a detection record.

## Storage

History uses IndexedDB `mopod-v5`; settings use localStorage. Each raw round is stored separately to avoid rewriting all raw data for every prediction. Interrupted browser sessions retain previously committed results. Live and Demo records carry separate source labels. Clearing browser data deletes local history. Export all records produces a JSON backup with raw rounds; a Quick Scan record exports the original nine-column CSV layout.

## Verification

`tests/mobile-flow.cjs` uses Playwright plus explicitly mocked BLE/ONNX fixtures. It checks phone layouts, fixed navigation, live/Demo isolation, missing validation, four result pages, exact 224-point rounds, five-fold mean, 20% speed command, LED shutdown, CSV content, local History, deletion and model entries. It does not establish physical device performance or application-model validity.

Use your installed Node executable to run it. Set `MOPOD_PLAYWRIGHT` to your Playwright package path if needed; the test's default path matches this development workstation. Screenshot previews are written under `tests/`. No real hardware was connected for this release.

`tests/real-model.cjs <path-to-CSV>` separately loads the actual CDN runtime and all five bundled models. On 2026-10-28, using the original `20260807_213527_R1.csv` reference, the V5 browser returned `0.8882598020136356%`; the original Python/ONNX reference was `0.8882597833871841%` (difference below 0.0001 percentage points).
