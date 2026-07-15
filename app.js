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
  adcCommand: 0x30,
  adcPacketType: 0x01,
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
  stopTimer: null,
  startTime: 0,
  samples: [],
  rejectedPackets: 0,
  modelSession: null,
  metadata: null,
};

const ui = Object.fromEntries([
  "connectButton", "startButton", "stopButton", "disconnectButton", "downloadButton",
  "durationInput", "connectionText", "connectionDot", "compatibilityWarning",
  "sampleCount", "progressBar", "signalCanvas", "resultName", "resultConfidence",
  "probabilityList", "logOutput",
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
  ui.startButton.disabled = !connected || state.collecting;
  ui.disconnectButton.disabled = !connected;
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
    state.modelSession = await ort.InferenceSession.create("./model/liquid_classifier.onnx", {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    ui.resultConfidence.textContent = `模型已就绪 · ${state.metadata.modelName}`;
    log(`模型加载完成，输入 ${state.metadata.seqLen}×${state.metadata.features.length}`);
  } catch (error) {
    ui.resultConfidence.textContent = "模型尚未就绪，仍可测试蓝牙采集";
    log(`模型加载失败：${error.message}`);
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
    state.dataCharacteristic.addEventListener("characteristicvaluechanged", handleDataPacket);

    try {
      state.statusCharacteristic = await service.getCharacteristic(BLE.status);
      await state.statusCharacteristic.startNotifications();
    } catch (error) {
      log(`状态特征订阅跳过：${error.message}`);
    }

    setConnected(true, device.name);
    log(`BLE 已连接：${device.name || "未命名设备"}`);
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
  setConnected(false);
  ui.stopButton.disabled = true;
  log("ESP32 已断开");
}

async function disconnectDevice() {
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  else handleDisconnected();
}

async function writeCommand(commandId, params) {
  if (!state.commandCharacteristic) throw new Error("命令特征不可用");
  const frame = buildCommand(commandId, params);
  await state.commandCharacteristic.writeValueWithResponse(frame);
  log(`发送指令：${Array.from(frame, (value) => value.toString(16).padStart(2, "0")).join(" ")}`);
}

async function startCollection() {
  if (!state.server?.connected || state.collecting) return;
  const duration = Math.max(500, Math.min(10000, Number(ui.durationInput.value) || 1800));
  ui.durationInput.value = duration;
  state.samples = [];
  state.rejectedPackets = 0;
  state.startTime = performance.now();
  state.collecting = true;
  ui.startButton.disabled = true;
  ui.stopButton.disabled = false;
  ui.downloadButton.disabled = true;
  ui.resultName.textContent = "采集中…";
  ui.resultConfidence.textContent = `计划采集 ${duration} ms`;
  ui.probabilityList.innerHTML = "";
  updateProgress(duration);
  drawSignals();

  try {
    await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.continuousMode]);
    state.stopTimer = setTimeout(() => stopCollection(true), duration);
  } catch (error) {
    state.collecting = false;
    ui.startButton.disabled = false;
    ui.stopButton.disabled = true;
    log(`启动采集失败：${error.message}`);
  }
}

async function stopCollection(runInference = true) {
  if (!state.collecting) return;
  clearTimeout(state.stopTimer);
  state.collecting = false;
  try {
    await writeCommand(PROTOCOL.adcCommand, [PROTOCOL.stopMode]);
  } catch (error) {
    log(`停止指令发送失败：${error.message}`);
  }
  ui.startButton.disabled = !state.server?.connected;
  ui.stopButton.disabled = true;
  ui.downloadButton.disabled = state.samples.length === 0;
  ui.progressBar.style.width = "100%";
  log(`采集结束：有效 ${state.samples.length} 包，无效 ${state.rejectedPackets} 包`);

  if (state.samples.length < 2) {
    ui.resultName.textContent = "数据不足";
    ui.resultConfidence.textContent = "至少需要 2 个有效数据点";
    return;
  }
  if (runInference) await classifySamples();
}

function handleDataPacket(event) {
  const view = event.target.value;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes.length < 10 || bytes[0] !== PROTOCOL.receiveHead || bytes[1] !== PROTOCOL.adcPacketType) return;
  if (sumChecksum(bytes.subarray(0, -1)) !== bytes[bytes.length - 1]) {
    state.rejectedPackets += 1;
    return;
  }
  if (!state.collecting) return;

  state.samples.push({
    elapsedMs: performance.now() - state.startTime,
    ch1: view.getUint16(2, true),
    ch2: view.getUint16(4, true),
    ch3: view.getUint16(6, true),
    roundIndex: view.getUint8(8),
  });

  const duration = Number(ui.durationInput.value) || 1800;
  updateProgress(duration);
  if (state.samples.length % 4 === 0) drawSignals();
}

function updateProgress(duration) {
  const elapsed = state.collecting ? performance.now() - state.startTime : duration;
  ui.progressBar.style.width = `${Math.min(100, elapsed / duration * 100)}%`;
  ui.sampleCount.textContent = `${state.samples.length} 个数据点`;
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

function prepareModelInput(samples, metadata) {
  const ch2 = resample(samples.map((sample) => sample.ch2), metadata.seqLen);
  const ch3 = resample(samples.map((sample) => sample.ch3), metadata.seqLen);
  const output = new Float32Array(metadata.seqLen * 4);
  for (let index = 0; index < metadata.seqLen; index += 1) {
    const features = [ch2[index], ch3[index], ch3[index] / (ch2[index] + 1e-6), ch3[index] - ch2[index]];
    for (let channel = 0; channel < 4; channel += 1) {
      output[index * 4 + channel] = (features[channel] - metadata.normalization.mean[channel]) / metadata.normalization.std[channel];
    }
  }
  return output;
}

function softmax(values) {
  const maxValue = Math.max(...values);
  const exponents = values.map((value) => Math.exp(value - maxValue));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  return exponents.map((value) => value / total);
}

async function classifySamples() {
  if (!state.modelSession || !state.metadata) {
    ui.resultName.textContent = "采集成功";
    ui.resultConfidence.textContent = "模型未加载，已保留数据供测试";
    return;
  }
  try {
    ui.resultName.textContent = "计算中…";
    const inputData = prepareModelInput(state.samples, state.metadata);
    const inputName = state.modelSession.inputNames[0];
    const feeds = { [inputName]: new ort.Tensor("float32", inputData, [1, state.metadata.seqLen, 4]) };
    const outputs = await state.modelSession.run(feeds);
    const logits = Array.from(outputs[state.modelSession.outputNames[0]].data);
    const probabilities = softmax(logits);
    const bestIndex = probabilities.indexOf(Math.max(...probabilities));
    const confidence = probabilities[bestIndex];
    const threshold = state.metadata.confidenceThreshold ?? 0.7;
    ui.resultName.textContent = confidence >= threshold ? state.metadata.labels[bestIndex] : "无法可靠识别";
    ui.resultConfidence.textContent = `置信度 ${(confidence * 100).toFixed(1)}% · ${state.samples.length} 个数据点`;
    renderProbabilities(probabilities);
    log(`推理完成：${state.metadata.labels[bestIndex]} ${(confidence * 100).toFixed(2)}%`);
  } catch (error) {
    ui.resultName.textContent = "推理失败";
    ui.resultConfidence.textContent = error.message;
    log(`推理失败：${error.stack || error.message}`);
  }
}

function renderProbabilities(probabilities) {
  ui.probabilityList.innerHTML = probabilities
    .map((probability, index) => ({ probability, label: state.metadata.labels[index] }))
    .sort((a, b) => b.probability - a.probability)
    .map(({ probability, label }) => `
      <div class="probability-row">
        <span>${label}</span>
        <div class="probability-track"><div class="probability-fill" style="width:${probability * 100}%"></div></div>
        <strong>${(probability * 100).toFixed(1)}%</strong>
      </div>`).join("");
}

function drawSignals() {
  const canvas = ui.signalCanvas;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#e0e6ee";
  context.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) {
    context.beginPath();
    context.moveTo(0, height * row / 4);
    context.lineTo(width, height * row / 4);
    context.stroke();
  }
  if (state.samples.length < 2) return;
  const allValues = state.samples.flatMap((sample) => [sample.ch2, sample.ch3]);
  let minValue = Math.min(...allValues);
  let maxValue = Math.max(...allValues);
  if (maxValue === minValue) maxValue = minValue + 1;
  const drawChannel = (key, color) => {
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 3;
    state.samples.forEach((sample, index) => {
      const x = index / (state.samples.length - 1) * width;
      const y = height - (sample[key] - minValue) / (maxValue - minValue) * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };
  drawChannel("ch2", "#0b6bcb");
  drawChannel("ch3", "#f08c00");
}

function downloadCsv() {
  if (!state.samples.length) return;
  const rows = ["Elapsed_ms,CH1_mV,CH2_mV,CH3_mV,Round_Index"];
  for (const sample of state.samples) {
    rows.push(`${sample.elapsedMs.toFixed(3)},${sample.ch1},${sample.ch2},${sample.ch3},${sample.roundIndex}`);
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

showCompatibility();
setConnected(false);
drawSignals();
loadModel();
