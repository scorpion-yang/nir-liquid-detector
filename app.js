"use strict";

const BLE = Object.freeze({
  deviceName: "nimble-ble-spp-svr",
  service: "0000abf0-0000-1000-8000-00805f9b34fb",
  command: "0000abf1-0000-1000-8000-00805f9b34fb",
  data: "0000abf2-0000-1000-8000-00805f9b34fb",
  status: "0000abf3-0000-1000-8000-00805f9b34fb",
});

const PROTOCOL = Object.freeze({
  sendHead: 0xa5,
  receiveHead: 0x5a,
  ledCommand: 0x10,
  servoTypeCommand: 0x24,
  servoConfigCommand: 0x25,
  adcCommand: 0x30,
  syncCommand: 0x40,
  adcPacketType: 0x01,
  adcBatchPacketType: 0x07,
  ledPacketType: 0x02,
  syncPacketType: 0x04,
  stopMode: 0x00,
  continuousMode: 0x02,
  servo360Mode: 0x01,
});

const ACQUISITION = Object.freeze({
  samplesPerRound: 224,
  windowSeconds: 1.5,
  firmwareDurationMs: 1500,
  servoSpeedPercent: 20,
  roundTimeoutMs: 4500,
  minimumTotalSeconds: 2,
  maximumTotalSeconds: 600,
});

const state = {
  compatible: true,
  device: null,
  server: null,
  commandCharacteristic: null,
  dataCharacteristic: null,
  statusCharacteristic: null,
  ledOn: false,
  ledPending: false,
  modelSessions: [],
  metadata: null,
  runId: 0,
  runActive: false,
  processing: false,
  abortRequested: false,
  plannedRounds: 0,
  currentRound: null,
  cleanupPromise: null,
  inferenceChain: Promise.resolve(),
  inferencePromises: [],
  rawRounds: [],
  results: [],
  rejectedPackets: 0,
};

const ui = Object.fromEntries([
  "connectButton", "startButton", "stopButton", "disconnectButton", "downloadButton",
  "durationInput", "durationHint", "connectionText", "connectionDot", "compatibilityWarning",
  "resultName", "resultDetail", "roundStatus", "concentrationChart", "logOutput",
].map((id) => [id, document.getElementById(id)]));

function log(message) {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  ui.logOutput.textContent += `[${timestamp}] ${message}\n`;
  ui.logOutput.scrollTop = ui.logOutput.scrollHeight;
}

function sumChecksum(bytes) {
  let total = 0;
  for (const value of bytes) total = (total + value) & 0xff;
  return total;
}

function buildCommand(commandId, params = []) {
  const frame = new Uint8Array(4 + params.length);
  frame[0] = PROTOCOL.sendHead;
  frame[1] = commandId;
  frame[2] = params.length;
  frame.set(params, 3);
  frame[frame.length - 1] = sumChecksum(frame.subarray(0, -1));
  return frame;
}

function isConnected() {
  return Boolean(state.server?.connected);
}

function modelsReady() {
  return Boolean(state.metadata)
    && state.modelSessions.length === 5
    && state.modelSessions.length === state.metadata.folds.length;
}

function updateControls() {
  const connected = isConnected();
  ui.connectButton.disabled = connected || state.processing || !state.compatible;
  ui.startButton.disabled = !connected || !modelsReady() || state.processing;
  ui.stopButton.disabled = !state.runActive;
  ui.disconnectButton.disabled = !connected;
  ui.durationInput.disabled = state.processing;
  ui.downloadButton.disabled = state.results.length === 0;
}

function setConnected(connected, name = "") {
  ui.connectionText.textContent = connected ? `已连接：${name || BLE.deviceName}` : "未连接";
  ui.connectionDot.classList.toggle("online", connected);
  ui.connectionDot.classList.toggle("offline", !connected);
  if (!connected) state.ledOn = false;
  updateControls();
}

function showCompatibility() {
  const messages = [];
  if (!window.isSecureContext) messages.push("当前页面不是安全上下文，请通过 HTTPS 的 GitHub Pages 打开。");
  if (!("bluetooth" in navigator)) messages.push("当前浏览器不支持 Web Bluetooth，请使用 Android Chrome 或 Windows Chrome/Edge。");
  if (messages.length) {
    state.compatible = false;
    ui.compatibilityWarning.hidden = false;
    ui.compatibilityWarning.textContent = messages.join(" ");
    ui.connectButton.disabled = true;
  }
}

function formatSeconds(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function getDurationPlan(clampValue = false) {
  let seconds = Number(ui.durationInput.value);
  if (clampValue) {
    if (!Number.isFinite(seconds)) seconds = 60;
    seconds = Math.max(ACQUISITION.minimumTotalSeconds, Math.min(ACQUISITION.maximumTotalSeconds, seconds));
    ui.durationInput.value = String(seconds);
  }
  if (!Number.isFinite(seconds)
      || seconds < ACQUISITION.minimumTotalSeconds
      || seconds > ACQUISITION.maximumTotalSeconds) {
    return null;
  }
  const rounds = Math.floor(seconds / ACQUISITION.windowSeconds);
  return { seconds, rounds, finalTime: rounds * ACQUISITION.windowSeconds };
}

function updateDurationHint() {
  const plan = getDurationPlan(false);
  if (!plan) {
    ui.durationHint.textContent = "请输入 2–600 秒";
    return;
  }
  ui.durationHint.textContent = `共 ${plan.rounds} 轮；最后一个结果位于 ${formatSeconds(plan.finalTime)} 秒`;
  if (!state.processing) {
    state.plannedRounds = plan.rounds;
    drawChart();
  }
}

async function loadModels() {
  try {
    if (!window.ort) throw new Error("ONNX Runtime Web 未加载，请检查网络连接");
    if (!window.NIRPreprocessing) throw new Error("V8 数据预处理模块未加载");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
    const response = await fetch("./model/metadata.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`模型元数据加载失败：HTTP ${response.status}`);
    state.metadata = await response.json();
    if (state.metadata.task !== "regression" || state.metadata.seqLen !== ACQUISITION.samplesPerRound) {
      throw new Error("模型元数据与 224 点浓度检测流程不匹配");
    }
    if (!Array.isArray(state.metadata.folds) || state.metadata.folds.length !== 5) {
      throw new Error("模型元数据必须包含五个交叉验证模型");
    }
    state.modelSessions = [];
    for (let index = 0; index < state.metadata.folds.length; index += 1) {
      ui.resultDetail.textContent = `正在加载模型 ${index + 1}/5…`;
      const session = await ort.InferenceSession.create(state.metadata.folds[index].modelPath, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      state.modelSessions.push(session);
    }
    ui.resultDetail.textContent = "五个浓度模型已就绪";
    log("V8 五折浓度模型加载完成");
  } catch (error) {
    state.modelSessions = [];
    ui.resultDetail.textContent = "模型加载失败，请检查网络后刷新页面";
    log(`模型加载失败：${error.message}`);
  }
  updateControls();
}

async function connectDevice() {
  try {
    log("正在打开蓝牙设备选择器…");
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE.service] }] });
    state.device = device;
    device.addEventListener("gattserverdisconnected", handleDisconnected);
    state.server = await device.gatt.connect();
    const service = await state.server.getPrimaryService(BLE.service);
    state.commandCharacteristic = await service.getCharacteristic(BLE.command);
    state.dataCharacteristic = await service.getCharacteristic(BLE.data);
    await state.dataCharacteristic.startNotifications();
    state.dataCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);

    try {
      state.statusCharacteristic = await service.getCharacteristic(BLE.status);
      await state.statusCharacteristic.startNotifications();
      state.statusCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    } catch (error) {
      log(`状态特征订阅跳过：${error.message}`);
    }

    setConnected(true, device.name);
    log(`BLE 已连接：${device.name || "未命名设备"}`);
    await writeCommand(PROTOCOL.syncCommand, [], false);
  } catch (error) {
    log(`连接失败：${error.message}`);
    setConnected(false);
  }
}

function rejectCurrentRound(error) {
  const context = state.currentRound;
  if (!context?.accepting) return;
  context.accepting = false;
  clearTimeout(context.timeoutId);
  context.reject(error);
}

function handleDisconnected() {
  state.runActive = false;
  state.abortRequested = true;
  rejectCurrentRound(new Error("ESP32 蓝牙连接已断开"));
  state.server = null;
  state.commandCharacteristic = null;
  state.dataCharacteristic = null;
  state.statusCharacteristic = null;
  state.ledPending = false;
  setConnected(false);
  log("ESP32 已断开");
}

async function disconnectDevice() {
  if (state.runActive) await stopCollection();
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  else handleDisconnected();
}

async function writeCommand(commandId, params, writeLog = true) {
  if (!state.commandCharacteristic) throw new Error("命令特征不可用");
  const frame = buildCommand(commandId, params);
  await state.commandCharacteristic.writeValueWithResponse(frame);
  if (writeLog) {
    log(`发送指令：${Array.from(frame, (value) => value.toString(16).padStart(2, "0")).join(" ")}`);
  }
}

async function setLed(enabled) {
  if (!isConnected()) throw new Error("设备未连接");
  if (state.ledPending) throw new Error("LED 指令正在执行");
  state.ledPending = true;
  try {
    await writeCommand(PROTOCOL.ledCommand, [enabled ? 1 : 0], false);
    state.ledOn = enabled;
    log(`LED ${enabled ? "已开启" : "已关闭"}`);
  } finally {
    state.ledPending = false;
  }
}

function littleEndianBytes(value, byteCount) {
  const output = [];
  let remaining = value;
  for (let index = 0; index < byteCount; index += 1) {
    output.push(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return output;
}

async function configureHardware(rounds) {
  await setLed(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeCommand(PROTOCOL.servoTypeCommand, [PROTOCOL.servo360Mode], false);
  const params = [
    ...littleEndianBytes(ACQUISITION.firmwareDurationMs, 4),
    ...littleEndianBytes(rounds, 2),
    ACQUISITION.servoSpeedPercent,
  ];
  await writeCommand(PROTOCOL.servoConfigCommand, params, false);
  log(`采集参数已设置：每轮 1500 ms，${rounds} 轮，舵机速度 20%`);
}

function armRound(roundNumber) {
  let resolve;
  let reject;
  const completed = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const context = {
    roundNumber,
    deviceRoundIndex: null,
    samplesByIndex: new Map(),
    firstEspTimeUs: null,
    accepting: true,
    resolve,
    reject,
    completed,
    timeoutId: null,
  };
  context.timeoutId = setTimeout(() => {
    if (!context.accepting) return;
    context.accepting = false;
    context.reject(new Error(
      `第 ${roundNumber} 轮等待超时：只收到 ${context.samplesByIndex.size}/${ACQUISITION.samplesPerRound} 个有效点`,
    ));
  }, ACQUISITION.roundTimeoutMs);
  state.currentRound = context;
  ui.roundStatus.textContent = `第 ${roundNumber}/${state.plannedRounds} 轮 · 0/224 点`;
  return context;
}

function acceptBatch(roundIndex, samples) {
  const context = state.currentRound;
  if (!state.runActive || !context?.accepting) return;

  let startAt = 0;
  if (context.deviceRoundIndex === null) {
    startAt = samples.findIndex((sample) => sample.sampleIndex === 0);
    if (startAt < 0) return;
    context.deviceRoundIndex = roundIndex;
  }
  if (roundIndex !== context.deviceRoundIndex) return;

  for (let index = startAt; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.sampleIndex < 0 || sample.sampleIndex >= ACQUISITION.samplesPerRound) continue;
    if (context.samplesByIndex.has(sample.sampleIndex)) continue;
    if (context.firstEspTimeUs === null) context.firstEspTimeUs = sample.espTimeUs;
    context.samplesByIndex.set(sample.sampleIndex, {
      ...sample,
      roundIndex,
      elapsedInRoundMs: (sample.espTimeUs - context.firstEspTimeUs) / 1000,
    });
  }

  const pointCount = context.samplesByIndex.size;
  ui.roundStatus.textContent = `第 ${context.roundNumber}/${state.plannedRounds} 轮 · ${pointCount}/224 点`;
  if (pointCount !== ACQUISITION.samplesPerRound) return;

  const ordered = [];
  for (let sampleIndex = 0; sampleIndex < ACQUISITION.samplesPerRound; sampleIndex += 1) {
    const sample = context.samplesByIndex.get(sampleIndex);
    if (!sample) return;
    ordered.push(sample);
  }
  context.accepting = false;
  clearTimeout(context.timeoutId);
  context.resolve(ordered);
}

function getUint64AsNumber(view, offset) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 0x100000000 + low;
}

function parseAdcBatch(view) {
  if (view.byteLength < 5) return;
  const roundIndex = view.getUint8(2);
  const sampleCount = view.getUint8(3);
  if (view.byteLength !== 5 + sampleCount * 16) {
    state.rejectedPackets += 1;
    return;
  }
  const samples = [];
  let offset = 4;
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push({
      sampleIndex: view.getUint32(offset, true),
      espTimeUs: getUint64AsNumber(view, offset + 4),
      ch2: view.getUint16(offset + 12, true),
      ch3: view.getUint16(offset + 14, true),
    });
    offset += 16;
  }
  acceptBatch(roundIndex, samples);
}

function handleNotification(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes.length < 3 || bytes[0] !== PROTOCOL.receiveHead) return;
  if (sumChecksum(bytes.subarray(0, -1)) !== bytes[bytes.length - 1]) {
    state.rejectedPackets += 1;
    return;
  }
  const packetType = bytes[1];
  if (packetType === PROTOCOL.ledPacketType && bytes.length >= 5) {
    state.ledOn = bytes[2] !== 0;
    return;
  }
  if (packetType === PROTOCOL.syncPacketType && bytes.length >= 7) {
    state.ledOn = bytes[2] !== 0;
    return;
  }
  if (!state.runActive) return;
  if (packetType === PROTOCOL.adcBatchPacketType) {
    parseAdcBatch(view);
  } else if (packetType === PROTOCOL.adcPacketType) {
    state.rejectedPackets += 1;
  }
}

function normalizeFeatures(features, normalization) {
  const output = new Float32Array(features.length);
  const channels = normalization.mean.length;
  for (let index = 0; index < features.length; index += 1) {
    const channel = index % channels;
    output[index] = (features[index] - normalization.mean[channel]) / normalization.std[channel];
  }
  return output;
}

async function inferRound(samples) {
  const prepared = window.NIRPreprocessing.prepareFeatures(samples, state.metadata.seqLen);
  const predictions = [];
  for (let index = 0; index < state.modelSessions.length; index += 1) {
    const session = state.modelSessions[index];
    const fold = state.metadata.folds[index];
    const inputData = normalizeFeatures(prepared.features, fold.normalization);
    const outputs = await session.run({
      [session.inputNames[0]]: new ort.Tensor(
        "float32",
        inputData,
        [1, state.metadata.seqLen, state.metadata.inputChannels],
      ),
    });
    const raw = Number(outputs[session.outputNames[0]].data[0]);
    const clamped = Math.max(0, Math.min(1, raw));
    predictions.push(
      state.metadata.targetMin
      + clamped * (state.metadata.targetMax - state.metadata.targetMin),
    );
  }
  const concentration = predictions.reduce((total, value) => total + value, 0) / predictions.length;
  return { concentration, alignment: prepared.alignment };
}

function queueInference(runId, roundNumber, samples) {
  const task = state.inferenceChain.then(
    () => inferRound(samples),
    () => inferRound(samples),
  );
  state.inferenceChain = task.catch(() => undefined);
  state.inferencePromises.push(task);
  task.then(({ concentration, alignment }) => {
    if (runId !== state.runId) return;
    const result = {
      roundNumber,
      timeSeconds: roundNumber * ACQUISITION.windowSeconds,
      concentration,
      periodSamples: alignment.periodSamples,
    };
    state.results.push(result);
    state.results.sort((left, right) => left.roundNumber - right.roundNumber);
    ui.resultName.textContent = `${concentration.toFixed(2)}%`;
    ui.resultDetail.textContent = `第 ${roundNumber} 轮 · 五模型平均结果`;
    ui.roundStatus.textContent = `已采集 ${state.rawRounds.length}/${state.plannedRounds} · 已计算 ${state.results.length}`;
    ui.downloadButton.disabled = false;
    drawChart();
    log(`第 ${roundNumber} 轮完成：${concentration.toFixed(2)}%`);
  }).catch((error) => {
    if (runId !== state.runId) return;
    ui.resultDetail.textContent = `第 ${roundNumber} 轮计算失败：${error.message}`;
    log(`第 ${roundNumber} 轮推理失败：${error.stack || error.message}`);
  });
  return task;
}

async function cleanupHardware() {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    if (isConnected()) {
      try {
        await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.stopMode], false);
      } catch (error) {
        log(`停止 ADC 失败：${error.message}`);
      }
      try {
        await setLed(false);
      } catch (error) {
        log(`关闭 LED 失败：${error.message}`);
      }
    }
  })();
  return state.cleanupPromise;
}

async function startCollection() {
  if (!isConnected() || state.processing || !modelsReady()) return;
  const plan = getDurationPlan(true);
  if (!plan || plan.rounds < 1) return;

  const runId = state.runId + 1;
  state.runId = runId;
  state.runActive = true;
  state.processing = true;
  state.abortRequested = false;
  state.plannedRounds = plan.rounds;
  state.currentRound = null;
  state.cleanupPromise = null;
  state.inferenceChain = Promise.resolve();
  state.inferencePromises = [];
  state.rawRounds = [];
  state.results = [];
  state.rejectedPackets = 0;
  ui.resultName.textContent = "采集中…";
  ui.resultDetail.textContent = `计划 ${plan.rounds} 轮，每轮接收 224 个有效点`;
  ui.roundStatus.textContent = `0 / ${plan.rounds} 轮`;
  drawChart();
  updateControls();

  try {
    await configureHardware(plan.rounds);
    let context = armRound(1);
    await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.continuousMode], false);
    log(`开始连续检测：输入 ${plan.seconds} 秒，共 ${plan.rounds} 轮`);

    for (let roundNumber = 1; roundNumber <= plan.rounds; roundNumber += 1) {
      const samples = await context.completed;
      if (!state.runActive || runId !== state.runId) throw new Error("检测已停止");
      state.rawRounds.push({ roundNumber, samples });

      await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.stopMode], false);
      let nextContext = null;
      let nextStartPromise = null;
      if (roundNumber < plan.rounds) {
        nextContext = armRound(roundNumber + 1);
        nextStartPromise = writeCommand(PROTOCOL.adcCommand, [PROTOCOL.continuousMode], false);
      } else {
        state.currentRound = null;
      }

      queueInference(runId, roundNumber, samples);
      if (nextStartPromise) await nextStartPromise;
      context = nextContext;

      if (roundNumber === 1 || roundNumber === plan.rounds || roundNumber % 10 === 0) {
        log(`采集进度：${roundNumber}/${plan.rounds} 轮，每轮 224 点`);
      }
    }

    state.runActive = false;
    await cleanupHardware();
    ui.resultDetail.textContent = `采集完成，正在等待 ${state.inferencePromises.length - state.results.length} 轮计算`;
    await Promise.allSettled(state.inferencePromises);
    if (runId !== state.runId) return;

    const latest = state.results[state.results.length - 1];
    if (latest) ui.resultName.textContent = `${latest.concentration.toFixed(2)}%`;
    ui.resultDetail.textContent = state.results.length === plan.rounds
      ? `检测完成，共 ${plan.rounds} 轮`
      : `检测完成：${state.results.length}/${plan.rounds} 轮计算成功`;
    ui.roundStatus.textContent = `${state.results.length} / ${plan.rounds} 轮完成`;
    log(`全部结束：采集 ${state.rawRounds.length} 轮，计算成功 ${state.results.length} 轮，无效包 ${state.rejectedPackets}`);
  } catch (error) {
    state.runActive = false;
    rejectCurrentRound(error);
    await cleanupHardware();
    await Promise.allSettled(state.inferencePromises);
    if (state.abortRequested) {
      ui.resultName.textContent = state.results.length ? `${state.results[state.results.length - 1].concentration.toFixed(2)}%` : "已停止";
      ui.resultDetail.textContent = `检测已停止，完成 ${state.results.length}/${plan.rounds} 轮`;
      log("用户停止了连续检测");
    } else {
      ui.resultName.textContent = "检测失败";
      ui.resultDetail.textContent = error.message;
      log(`检测失败：${error.stack || error.message}`);
    }
  } finally {
    if (runId === state.runId) {
      state.runActive = false;
      state.processing = false;
      state.currentRound = null;
      updateControls();
      drawChart();
    }
  }
}

async function stopCollection() {
  if (!state.runActive) return;
  state.abortRequested = true;
  state.runActive = false;
  rejectCurrentRound(new Error("用户停止检测"));
  ui.stopButton.disabled = true;
  ui.resultDetail.textContent = "正在停止 ADC、舵机和 LED…";
  await cleanupHardware();
}

function drawChart() {
  const canvas = ui.concentrationChart;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(rect.width * ratio);
  const pixelHeight = Math.round(rect.height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);

  const margin = { left: 48, right: 16, top: 16, bottom: 38 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const xMaximum = Math.max(ACQUISITION.windowSeconds, state.plannedRounds * ACQUISITION.windowSeconds);
  context.font = "12px Inter, Microsoft YaHei, sans-serif";
  context.textBaseline = "middle";

  for (let tick = 0; tick <= 5; tick += 1) {
    const yValue = tick * 20;
    const y = margin.top + plotHeight * (1 - yValue / 100);
    context.strokeStyle = "#dce3ed";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(width - margin.right, y);
    context.stroke();
    context.fillStyle = "#697386";
    context.textAlign = "right";
    context.fillText(`${yValue}%`, margin.left - 8, y);
  }

  for (let tick = 0; tick <= 5; tick += 1) {
    const value = xMaximum * tick / 5;
    const x = margin.left + plotWidth * tick / 5;
    context.fillStyle = "#697386";
    context.textAlign = tick === 0 ? "left" : tick === 5 ? "right" : "center";
    context.fillText(formatSeconds(Number(value.toFixed(1))), x, height - 17);
  }

  context.strokeStyle = "#9eabbc";
  context.beginPath();
  context.moveTo(margin.left, margin.top);
  context.lineTo(margin.left, margin.top + plotHeight);
  context.lineTo(width - margin.right, margin.top + plotHeight);
  context.stroke();

  if (!state.results.length) {
    context.fillStyle = "#929bad";
    context.textAlign = "center";
    context.fillText("等待浓度数据", margin.left + plotWidth / 2, margin.top + plotHeight / 2);
    return;
  }

  const points = state.results.map((result) => ({
    x: margin.left + plotWidth * result.timeSeconds / xMaximum,
    y: margin.top + plotHeight * (1 - result.concentration / 100),
  }));
  context.strokeStyle = "#0b6bcb";
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.stroke();
  context.fillStyle = "#087f5b";
  for (const point of points) {
    context.beginPath();
    context.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
    context.fill();
  }
}

function downloadCsv() {
  if (!state.rawRounds.length) return;
  const concentrationByRound = new Map(state.results.map((result) => [result.roundNumber, result.concentration]));
  const rows = ["Round,Time_s,Concentration_percent,Sample_Index,ESP_Time_us,Elapsed_In_Round_ms,CH2_mV,CH3_mV,Device_Round_Index"];
  for (const round of state.rawRounds) {
    const concentration = concentrationByRound.get(round.roundNumber);
    for (const sample of round.samples) {
      rows.push([
        round.roundNumber,
        (round.roundNumber * ACQUISITION.windowSeconds).toFixed(1),
        concentration === undefined ? "" : concentration.toFixed(6),
        sample.sampleIndex,
        sample.espTimeUs,
        sample.elapsedInRoundMs.toFixed(3),
        sample.ch2,
        sample.ch3,
        sample.roundIndex,
      ].join(","));
    }
  }
  const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `concentration_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

ui.connectButton.addEventListener("click", () => { void connectDevice(); });
ui.startButton.addEventListener("click", () => { void startCollection(); });
ui.stopButton.addEventListener("click", () => { void stopCollection(); });
ui.disconnectButton.addEventListener("click", () => { void disconnectDevice(); });
ui.downloadButton.addEventListener("click", downloadCsv);
ui.durationInput.addEventListener("input", updateDurationHint);
window.addEventListener("resize", () => window.requestAnimationFrame(drawChart));

setConnected(false);
updateDurationHint();
showCompatibility();
drawChart();
void loadModels();
