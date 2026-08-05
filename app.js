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
  adcCommand: 0x30,
  syncCommand: 0x40,
  adcPacketType: 0x01,
  adcBatchPacketType: 0x07,
  ledPacketType: 0x02,
  syncPacketType: 0x04,
  stopMode: 0x00,
  continuousMode: 0x02,
});

const state = {
  device: null,
  server: null,
  commandCharacteristic: null,
  dataCharacteristic: null,
  statusCharacteristic: null,
  collecting: false,
  ledOn: false,
  ledPending: false,
  stopTimer: null,
  startTime: 0,
  firstEspTimeUs: null,
  samples: [],
  rejectedPackets: 0,
  modelSessions: [],
  metadata: null,
};

const ui = Object.fromEntries([
  "connectButton", "startButton", "stopButton", "disconnectButton", "downloadButton",
  "durationInput", "connectionText", "connectionDot", "compatibilityWarning",
  "resultName", "resultConfidence", "logOutput",
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

function setConnected(connected, name = "") {
  ui.connectionText.textContent = connected ? `已连接：${name || BLE.deviceName}` : "未连接";
  ui.connectionDot.classList.toggle("online", connected);
  ui.connectionDot.classList.toggle("offline", !connected);
  ui.connectButton.disabled = connected;
  const modelsReady = state.metadata && state.modelSessions.length === state.metadata.folds.length;
  ui.startButton.disabled = !connected || state.collecting || !modelsReady;
  ui.disconnectButton.disabled = !connected;
  if (!connected) state.ledOn = false;
}

function showCompatibility() {
  const messages = [];
  if (!window.isSecureContext) messages.push("当前页面不是安全上下文。请使用 HTTPS，或在电脑/手机上通过 http://localhost 打开。");
  if (!("bluetooth" in navigator)) messages.push("当前浏览器没有 Web Bluetooth。请使用 Android Chrome，或 Windows 上的 Chrome/Edge。");
  if (messages.length) {
    ui.compatibilityWarning.hidden = false;
    ui.compatibilityWarning.textContent = messages.join(" ");
    ui.connectButton.disabled = true;
  }
}

async function loadModel() {
  try {
    if (!window.ort) throw new Error("ONNX Runtime Web 未加载，请检查网络连接");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
    const metadataResponse = await fetch("./model/metadata.json", { cache: "no-store" });
    if (!metadataResponse.ok) throw new Error(`模型元数据加载失败：HTTP ${metadataResponse.status}`);
    state.metadata = await metadataResponse.json();
    if (!Array.isArray(state.metadata.folds) || state.metadata.folds.length !== 5) {
      throw new Error("模型元数据必须包含五个交叉验证模型");
    }
    state.modelSessions = [];
    for (let index = 0; index < state.metadata.folds.length; index += 1) {
      ui.resultConfidence.textContent = `正在加载模型 ${index + 1}/5…`;
      const session = await ort.InferenceSession.create(state.metadata.folds[index].modelPath, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      state.modelSessions.push(session);
    }
    ui.resultConfidence.textContent = `五模型已就绪 · 输入 ${state.metadata.seqLen}×${state.metadata.inputChannels}`;
    log(`五折模型加载完成，输入 ${state.metadata.seqLen}×${state.metadata.inputChannels}`);
    setConnected(Boolean(state.server?.connected), state.device?.name);
  } catch (error) {
    state.modelSessions = [];
    ui.resultConfidence.textContent = "五模型加载失败，请检查网络后刷新页面";
    log(`模型加载失败：${error.message}`);
    setConnected(Boolean(state.server?.connected), state.device?.name);
  }
}

async function connectDevice() {
  try {
    log("正在打开蓝牙设备选择器…");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE.service] }],
    });
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
    try {
      await writeCommand(PROTOCOL.syncCommand, []);
    } catch (error) {
      log(`LED 状态同步跳过：${error.message}`);
    }
  } catch (error) {
    log(`连接失败：${error.message}`);
  }
}

function handleDisconnected() {
  clearTimeout(state.stopTimer);
  state.collecting = false;
  state.server = null;
  state.commandCharacteristic = null;
  state.dataCharacteristic = null;
  state.statusCharacteristic = null;
  state.ledPending = false;
  setConnected(false);
  ui.stopButton.disabled = true;
  log("ESP32 已断开");
}

async function disconnectDevice() {
  if (!state.device?.gatt?.connected) {
    handleDisconnected();
    return;
  }
  if (state.collecting) {
    await stopCollection(false);
  } else if (state.ledOn) {
    try {
      await setLed(false);
    } catch (error) {
      log(`断开前关闭 LED 失败：${error.message}`);
    }
  }
  state.device.gatt.disconnect();
}

async function writeCommand(commandId, params) {
  if (!state.commandCharacteristic) throw new Error("命令特征不可用");
  const frame = buildCommand(commandId, params);
  await state.commandCharacteristic.writeValueWithResponse(frame);
  log(`发送指令：${Array.from(frame, (value) => value.toString(16).padStart(2, "0")).join(" ")}`);
}

async function setLed(enabled) {
  if (!state.server?.connected) throw new Error("设备未连接");
  if (state.ledPending) throw new Error("LED 指令正在执行");
  state.ledPending = true;
  try {
    await writeCommand(PROTOCOL.ledCommand, [enabled ? 1 : 0]);
    state.ledOn = enabled;
    log(`LED ${enabled ? "已开启" : "已关闭"}`);
  } finally {
    state.ledPending = false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startCollection() {
  if (!state.server?.connected || state.collecting || state.modelSessions.length !== 5) return;
  const duration = Math.max(500, Math.min(10000, Number(ui.durationInput.value) || 1800));
  ui.durationInput.value = duration;
  state.samples = [];
  state.rejectedPackets = 0;
  state.firstEspTimeUs = null;
  state.collecting = true;
  ui.startButton.disabled = true;
  ui.stopButton.disabled = true;
  ui.disconnectButton.disabled = true;
  ui.downloadButton.disabled = true;
  ui.resultName.textContent = "采集中…";
  ui.resultConfidence.textContent = `计划采集 ${duration} ms`;

  try {
    await setLed(true);
    await delay(100);
    state.startTime = performance.now();
    await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.continuousMode]);
    ui.stopButton.disabled = false;
    ui.disconnectButton.disabled = false;
    state.stopTimer = setTimeout(() => { void stopCollection(true); }, duration);
  } catch (error) {
    state.collecting = false;
    try {
      await setLed(false);
    } catch (ledError) {
      log(`关闭 LED 失败：${ledError.message}`);
    }
    ui.startButton.disabled = !state.server?.connected || state.modelSessions.length !== 5;
    ui.stopButton.disabled = true;
    ui.disconnectButton.disabled = !state.server?.connected;
    ui.resultName.textContent = "采集失败";
    ui.resultConfidence.textContent = error.message;
    log(`启动采集失败：${error.message}`);
  }
}

async function stopCollection(runInference = true) {
  if (!state.collecting) return;
  clearTimeout(state.stopTimer);
  state.collecting = false;
  ui.startButton.disabled = true;
  ui.stopButton.disabled = true;
  ui.disconnectButton.disabled = true;
  try {
    await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.stopMode]);
  } catch (error) {
    log(`停止指令发送失败：${error.message}`);
  }
  try {
    await setLed(false);
  } catch (error) {
    log(`关闭 LED 失败：${error.message}`);
  }
  ui.downloadButton.disabled = state.samples.length === 0;
  log(`采集结束：有效 ${state.samples.length} 个数据点，无效 ${state.rejectedPackets} 个数据包`);

  if (state.samples.length < 2) {
    ui.resultName.textContent = "数据不足";
    ui.resultConfidence.textContent = "至少需要 2 个有效数据点";
    ui.startButton.disabled = !state.server?.connected || state.modelSessions.length !== 5;
    ui.disconnectButton.disabled = !state.server?.connected;
    return;
  }
  if (runInference) await classifySamples();
  ui.startButton.disabled = !state.server?.connected || state.modelSessions.length !== 5;
  ui.disconnectButton.disabled = !state.server?.connected;
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
  if (!state.collecting) return;

  if (packetType === PROTOCOL.adcPacketType && bytes.length === 10) {
    state.samples.push({
      elapsedMs: performance.now() - state.startTime,
      sampleIndex: state.samples.length,
      espTimeUs: null,
      ch1: view.getUint16(2, true),
      ch2: view.getUint16(4, true),
      ch3: view.getUint16(6, true),
      roundIndex: view.getUint8(8),
    });
    return;
  }

  if (packetType === PROTOCOL.adcBatchPacketType) parseAdcBatch(view);
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
  const expectedLength = 5 + sampleCount * 16;
  if (view.byteLength !== expectedLength) {
    state.rejectedPackets += 1;
    return;
  }
  let offset = 4;
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleIndex = view.getUint32(offset, true);
    const espTimeUs = getUint64AsNumber(view, offset + 4);
    const ch2 = view.getUint16(offset + 12, true);
    const ch3 = view.getUint16(offset + 14, true);
    if (state.firstEspTimeUs === null) state.firstEspTimeUs = espTimeUs;
    state.samples.push({
      elapsedMs: (espTimeUs - state.firstEspTimeUs) / 1000,
      sampleIndex,
      espTimeUs,
      ch1: null,
      ch2,
      ch3,
      roundIndex,
    });
    offset += 16;
  }
}

function resample(values, targetLength) {
  if (values.length === targetLength) return Float32Array.from(values);
  const output = new Float32Array(targetLength);
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * (values.length - 1) / (targetLength - 1);
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const fraction = position - left;
    output[index] = values[left] * (1 - fraction) + values[right] * fraction;
  }
  return output;
}

function prepareBaseFeatures(samples, metadata) {
  const ch2 = resample(samples.map((sample) => sample.ch2), metadata.seqLen);
  const ch3 = resample(samples.map((sample) => sample.ch3), metadata.seqLen);
  const output = new Float32Array(metadata.seqLen * metadata.inputChannels);
  for (let index = 0; index < metadata.seqLen; index += 1) {
    const previous = index === 0 ? metadata.seqLen - 1 : index - 1;
    const safeCh2 = Math.max(ch2[index] + 1e-6, 1e-6);
    const safeCh3 = Math.max(ch3[index] + 1e-6, 1e-6);
    const denominator = Math.max(ch3[index] + ch2[index] + 1e-6, 1e-6);
    const features = [
      ch2[index],
      ch3[index],
      Math.log(safeCh3 / safeCh2),
      (ch3[index] - ch2[index]) / denominator,
      ch2[index] - ch2[previous],
      ch3[index] - ch3[previous],
    ];
    for (let channel = 0; channel < metadata.inputChannels; channel += 1) {
      output[index * metadata.inputChannels + channel] = features[channel];
    }
  }
  return output;
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

function argmax(values) {
  let bestIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[bestIndex]) bestIndex = index;
  }
  return bestIndex;
}

async function classifySamples() {
  if (!state.metadata || state.modelSessions.length !== 5) {
    ui.resultName.textContent = "采集成功";
    ui.resultConfidence.textContent = "五个模型尚未全部加载";
    return;
  }
  try {
    ui.resultName.textContent = "计算中…";
    const baseFeatures = prepareBaseFeatures(state.samples, state.metadata);
    const voteCounts = new Array(state.metadata.labels.length).fill(0);
    const foldVotes = [];

    for (let index = 0; index < state.modelSessions.length; index += 1) {
      const session = state.modelSessions[index];
      const fold = state.metadata.folds[index];
      const inputData = normalizeFeatures(baseFeatures, fold.normalization);
      const inputName = session.inputNames[0];
      const feeds = {
        [inputName]: new ort.Tensor(
          "float32",
          inputData,
          [1, state.metadata.seqLen, state.metadata.inputChannels],
        ),
      };
      const outputs = await session.run(feeds);
      const predictedIndex = argmax(outputs[session.outputNames[0]].data);
      voteCounts[predictedIndex] += 1;
      foldVotes.push(state.metadata.labels[predictedIndex]);
    }

    const winnerIndex = argmax(voteCounts);
    const winnerVotes = voteCounts[winnerIndex];
    const voteThreshold = state.metadata.voteThreshold ?? 3;
    ui.resultName.textContent = winnerVotes >= voteThreshold ? state.metadata.labels[winnerIndex] : "无法识别";
    ui.resultConfidence.textContent = "";
    log(`五模型投票：${foldVotes.join("、")}`);
    log(`最终结果：${ui.resultName.textContent}（最高 ${winnerVotes}/5 票）`);
  } catch (error) {
    ui.resultName.textContent = "推理失败";
    ui.resultConfidence.textContent = error.message;
    log(`推理失败：${error.stack || error.message}`);
  }
}

function downloadCsv() {
  if (!state.samples.length) return;
  const rows = ["Elapsed_ms,Sample_Index,ESP_Time_us,CH1_mV,CH2_mV,CH3_mV,Round_Index"];
  for (const sample of state.samples) {
    rows.push(`${sample.elapsedMs.toFixed(3)},${sample.sampleIndex},${sample.espTimeUs ?? ""},${sample.ch1 ?? ""},${sample.ch2},${sample.ch3},${sample.roundIndex}`);
  }
  const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `measurement_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

ui.connectButton.addEventListener("click", connectDevice);
ui.startButton.addEventListener("click", startCollection);
ui.stopButton.addEventListener("click", () => stopCollection(true));
ui.disconnectButton.addEventListener("click", disconnectDevice);
ui.downloadButton.addEventListener("click", downloadCsv);

setConnected(false);
showCompatibility();
loadModel();
