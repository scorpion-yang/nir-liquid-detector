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
  modelSession: null,
  metadata: null,
};

const ui = Object.fromEntries([
  "connectButton", "ledButton", "startButton", "stopButton", "disconnectButton", "downloadButton",
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
  ui.startButton.disabled = !connected || state.collecting;
  ui.disconnectButton.disabled = !connected;
  ui.ledButton.disabled = !connected || state.ledPending;
  if (!connected) state.ledOn = false;
  updateLedButton();
}

function updateLedButton() {
  ui.ledButton.textContent = state.ledOn ? "LED 已开启 · 点击关闭" : "LED 已关闭 · 点击开启";
  ui.ledButton.setAttribute("aria-pressed", String(state.ledOn));
  ui.ledButton.classList.toggle("led-on", state.ledOn);
  ui.ledButton.classList.toggle("led-off", !state.ledOn);
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
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
  else handleDisconnected();
}

async function writeCommand(commandId, params) {
  if (!state.commandCharacteristic) throw new Error("命令特征不可用");
  const frame = buildCommand(commandId, params);
  await state.commandCharacteristic.writeValueWithResponse(frame);
  log(`发送指令：${Array.from(frame, (value) => value.toString(16).padStart(2, "0")).join(" ")}`);
}

async function toggleLed() {
  if (!state.server?.connected || state.ledPending) return;
  const requestedState = !state.ledOn;
  state.ledPending = true;
  ui.ledButton.disabled = true;
  try {
    await writeCommand(PROTOCOL.ledCommand, [requestedState ? 1 : 0]);
    state.ledOn = requestedState;
    updateLedButton();
    log(`LED ${requestedState ? "已开启" : "已关闭"}`);
  } catch (error) {
    log(`LED 控制失败：${error.message}`);
  } finally {
    state.ledPending = false;
    ui.ledButton.disabled = !state.server?.connected;
  }
}

async function startCollection() {
  if (!state.server?.connected || state.collecting) return;
  const duration = Math.max(500, Math.min(10000, Number(ui.durationInput.value) || 1800));
  ui.durationInput.value = duration;
  state.samples = [];
  state.rejectedPackets = 0;
  state.startTime = performance.now();
  state.firstEspTimeUs = null;
  state.collecting = true;
  ui.startButton.disabled = true;
  ui.stopButton.disabled = false;
  ui.downloadButton.disabled = true;
  ui.resultName.textContent = "采集中…";
  ui.resultConfidence.textContent = `计划采集 ${duration} ms`;

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
  log(`采集结束：有效 ${state.samples.length} 个数据点，无效 ${state.rejectedPackets} 个数据包`);

  if (state.samples.length < 2) {
    ui.resultName.textContent = "数据不足";
    ui.resultConfidence.textContent = "至少需要 2 个有效数据点";
    return;
  }
  if (runInference) await classifySamples();
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
    updateLedButton();
    return;
  }
  if (packetType === PROTOCOL.syncPacketType && bytes.length >= 7) {
    state.ledOn = bytes[2] !== 0;
    updateLedButton();
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
    ui.resultConfidence.textContent = "";
    log(`推理完成：${state.metadata.labels[bestIndex]} ${(confidence * 100).toFixed(2)}%`);
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
ui.ledButton.addEventListener("click", toggleLed);
ui.startButton.addEventListener("click", startCollection);
ui.stopButton.addEventListener("click", () => stopCollection(true));
ui.disconnectButton.addEventListener("click", disconnectDevice);
ui.downloadButton.addEventListener("click", downloadCsv);

setConnected(false);
showCompatibility();
loadModel();
