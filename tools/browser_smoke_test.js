"use strict";

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {} });
  });
  await page.goto("http://127.0.0.1:8765/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.getElementById("resultDetail")?.textContent === "五个浓度模型已就绪",
    null,
    { timeout: 120000 },
  );

  const duration = page.locator("#durationInput");
  await duration.fill("2");
  await page.waitForFunction(() => document.getElementById("durationHint")?.textContent.includes("1 轮"));
  const minimumHint = await page.locator("#durationHint").textContent();
  await duration.fill("600");
  await page.waitForFunction(() => document.getElementById("durationHint")?.textContent.includes("400 轮"));
  const maximumHint = await page.locator("#durationHint").textContent();
  await duration.fill("60");

  const csvLines = fs.readFileSync(
    "G:\\Liquid\\260807\\Data\\0\\20260807_213527_R1.csv",
    "utf8",
  ).replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const csvHeader = csvLines[0].split(",");
  const indexColumn = csvHeader.indexOf("sample_index");
  const ch2Column = csvHeader.indexOf("CH2_mV");
  const ch3Column = csvHeader.indexOf("CH3_mV");
  const realSamples = csvLines.slice(1).map((line) => {
    const values = line.split(",");
    return {
      sampleIndex: Number(values[indexColumn]),
      ch2: Number(values[ch2Column]),
      ch3: Number(values[ch3Column]),
    };
  }).sort((left, right) => left.sampleIndex - right.sampleIndex).slice(0, 224);
  const browserInference = await page.evaluate(async (samples) => {
    const result = await inferRound(samples);
    return {
      concentration: result.concentration,
      periodSamples: result.alignment.periodSamples,
    };
  }, realSamples);
  const simulatedRun = await page.evaluate(async (samples) => {
    const commands = [];
    state.server = { connected: true };
    state.device = { name: "模拟 ESP32" };
    state.commandCharacteristic = {
      async writeValueWithResponse(frame) {
        const bytes = Array.from(frame);
        commands.push(bytes);
        if (bytes[1] === PROTOCOL.adcCommand && bytes[3] === PROTOCOL.continuousMode) {
          setTimeout(() => {
            for (let offset = 0; offset < samples.length; offset += 10) {
              acceptBatch(1, samples.slice(offset, offset + 10));
            }
          }, 0);
        }
      },
    };
    setConnected(true, "模拟 ESP32");
    document.getElementById("durationInput").value = "2";
    updateDurationHint();
    await startCollection();
    const servoConfig = commands.find((frame) => frame[1] === PROTOCOL.servoConfigCommand);
    return {
      resultName: document.getElementById("resultName").textContent,
      resultDetail: document.getElementById("resultDetail").textContent,
      rawRoundCount: state.rawRounds.length,
      resultCount: state.results.length,
      resultTime: state.results[0]?.timeSeconds,
      ledOn: state.ledOn,
      servoSpeedPercent: servoConfig?.[9],
      commandCount: commands.length,
    };
  }, realSamples.map((sample, index) => ({
    ...sample,
    espTimeUs: 1000000 + index * 6667,
  })));
  const fortyRoundRun = await page.evaluate(async (baseSamples) => {
    const originalInferRound = inferRound;
    let deviceRound = 0;
    inferRound = async (_samples) => ({
      concentration: 20 + deviceRound * 0.1,
      alignment: { periodSamples: 160 },
    });
    try {
      state.server = { connected: true };
      state.commandCharacteristic = {
        async writeValueWithResponse(frame) {
          const bytes = Array.from(frame);
          if (bytes[1] === PROTOCOL.adcCommand && bytes[3] === PROTOCOL.continuousMode) {
            deviceRound += 1;
            const currentDeviceRound = ((deviceRound - 1) % 255) + 1;
            const samples = baseSamples.map((sample) => ({
              ...sample,
              espTimeUs: deviceRound * 2000000 + sample.sampleIndex * 6667,
            }));
            setTimeout(() => {
              for (let offset = 0; offset < samples.length; offset += 10) {
                acceptBatch(currentDeviceRound, samples.slice(offset, offset + 10));
              }
            }, 0);
          }
        },
      };
      document.getElementById("durationInput").value = "60";
      updateDurationHint();
      await startCollection();
      return {
        rawRoundCount: state.rawRounds.length,
        resultCount: state.results.length,
        firstTime: state.results[0]?.timeSeconds,
        lastTime: state.results[state.results.length - 1]?.timeSeconds,
        status: document.getElementById("roundStatus").textContent,
      };
    } finally {
      inferRound = originalInferRound;
    }
  }, realSamples);

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    canvasWidth: document.getElementById("concentrationChart").getBoundingClientRect().width,
    modelText: document.getElementById("resultDetail").textContent,
    startDisabled: document.getElementById("startButton").disabled,
  }));
  await page.screenshot({
    path: path.join(__dirname, "mobile_preview.png"),
    fullPage: true,
  });
  await browser.close();

  if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join(" | ")}`);
  if (failedRequests.length) throw new Error(`Failed requests: ${failedRequests.join(" | ")}`);
  if (layout.documentWidth > layout.viewportWidth) throw new Error(`Horizontal overflow: ${JSON.stringify(layout)}`);
  if (!minimumHint.includes("最后一个结果位于 1.5 秒")) throw new Error(`Bad minimum hint: ${minimumHint}`);
  if (!maximumHint.includes("最后一个结果位于 600 秒")) throw new Error(`Bad maximum hint: ${maximumHint}`);
  if (browserInference.periodSamples !== 153) throw new Error(`Bad alignment: ${JSON.stringify(browserInference)}`);
  if (Math.abs(browserInference.concentration - 0.8882597833871841) > 1e-4) {
    throw new Error(`Browser/Python inference mismatch: ${JSON.stringify(browserInference)}`);
  }
  if (simulatedRun.rawRoundCount !== 1 || simulatedRun.resultCount !== 1 || simulatedRun.resultTime !== 1.5) {
    throw new Error(`Bad simulated acquisition: ${JSON.stringify(simulatedRun)}`);
  }
  if (simulatedRun.servoSpeedPercent !== 20 || simulatedRun.ledOn) {
    throw new Error(`Bad hardware lifecycle: ${JSON.stringify(simulatedRun)}`);
  }
  if (fortyRoundRun.rawRoundCount !== 40 || fortyRoundRun.resultCount !== 40
      || fortyRoundRun.firstTime !== 1.5 || fortyRoundRun.lastTime !== 60) {
    throw new Error(`Bad 60-second run: ${JSON.stringify(fortyRoundRun)}`);
  }
  process.stdout.write(JSON.stringify({
    layout,
    minimumHint,
    maximumHint,
    browserInference,
    simulatedRun,
    fortyRoundRun,
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
