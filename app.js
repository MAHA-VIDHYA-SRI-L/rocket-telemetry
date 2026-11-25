const BROKER_URL = "wss://obdc2608.ala.us-east-1.emqxsl.com:8084/mqtt";
const TOPIC = "rocket/rocket-001/telemetry";
const HISTORY_LIMIT = 60;
const LOG_LIMIT = 50;

const elements = {
  connectionPill: document.getElementById("connection-pill"),
  connectionStatus: document.getElementById("connection-status"),
  connectionDetail: document.getElementById("connection-detail"),
  connectButton: document.getElementById("connect-button"),
  disconnectButton: document.getElementById("disconnect-button"),
  form: document.getElementById("connection-form"),
  username: document.getElementById("mqtt-username"),
  password: document.getElementById("mqtt-password"),
  subscriptionState: document.getElementById("subscription-state"),
  lastMessageTime: document.getElementById("last-message-time"),
  packetCount: document.getElementById("packet-count"),
  telemetry: document.getElementById("telemetry"),
  log: document.getElementById("telemetry-log"),
  clearLog: document.getElementById("clear-log-button"),
  gpsState: document.getElementById("gps-state"),
  gpsWarning: document.getElementById("gps-warning"),
  imuState: document.getElementById("imu-state"),
  attitudeState: document.getElementById("attitude-state"),
  attitudeCalibrationState: document.getElementById("attitude-calibration-state"),
  attitudePitch: document.getElementById("attitude-pitch"),
  attitudeRoll: document.getElementById("attitude-roll"),
  attitudeYaw: document.getElementById("attitude-yaw"),
  attitudeFreshness: document.getElementById("attitude-freshness"),
  attitudeTracking: document.getElementById("attitude-tracking"),
  attitudeCalibrate: document.getElementById("attitude-calibrate"),
  attitudeReset: document.getElementById("attitude-reset"),
  cameraReset: document.getElementById("camera-reset"),
  debugMqttRate: document.getElementById("debug-mqtt-rate"),
  debugSampleAge: document.getElementById("debug-sample-age"),
  debugPacketInterval: document.getElementById("debug-packet-interval"),
  debugAngles: document.getElementById("debug-angles"),
  debugGyroBias: document.getElementById("debug-gyro-bias"),
  debugMotion: document.getElementById("debug-motion"),
  debugFps: document.getElementById("debug-fps"),
  debugValidity: document.getElementById("debug-validity")
};

let attitudeView = null;
let mqttPacketTimes = [];
let mqttRate = 0;
let client = null;
let credentials = null;
let packetCount = 0;
let subscribed = false;
let connecting = false;
let manualDisconnect = false;
let connectionToken = 0;
const charts = {};
const history = {
  labels: [],
  altitude: [],
  temperature: [],
  accelX: [],
  accelY: [],
  accelZ: []
};

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value, digits = 2) {
  return isFiniteNumber(value) ? value.toFixed(digits) : "--";
}

function nowText() {
  const now = new Date();
  return `${now.toLocaleTimeString([], { hour12: false })}.${String(now.getMilliseconds()).padStart(3, "0")}`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setConnection(state, label, detail, tone) {
  elements.connectionPill.dataset.state = state;
  elements.connectionStatus.textContent = label;
  if (detail !== undefined) elements.connectionDetail.textContent = detail;
  if (tone) elements.connectionDetail.dataset.tone = tone;
  else delete elements.connectionDetail.dataset.tone;
}

function setTag(element, label, tone) {
  element.textContent = label;
  element.className = `tag tag-${tone}`;
}

function setSubscription(label, tone) {
  setTag(elements.subscriptionState, label, tone);
}

function setButtons() {
  const busy = connecting || Boolean(client && (client.connected || client.reconnecting));
  elements.connectButton.disabled = busy;
  elements.disconnectButton.disabled = !client;
}

function setMetric(valueId, stateId, value, digits = 2) {
  setText(valueId, formatNumber(value, digits));
  const state = document.getElementById(stateId);
  if (!state) return;
  const live = isFiniteNumber(value);
  state.textContent = live ? "LIVE" : "NO DATA";
  state.dataset.state = live ? "live" : "unknown";
}

function renderBmp(bmp) {
  setMetric("temperature", "temperature-state", bmp.temperature_c, 2);
  setMetric("pressure", "pressure-state", bmp.pressure_hpa, 2);
  setMetric("altitude", "altitude-state", bmp.altitude_m, 2);
}

function renderImu(data) {
  const imu = data.mpu6050 ?? {};
  const accel = Array.isArray(imu.accel_m_s2) ? imu.accel_m_s2 : [];
  const gyro = Array.isArray(imu.gyro_rad_s) ? imu.gyro_rad_s : [];

  setText("accel-x", formatNumber(accel[0]));
  setText("accel-y", formatNumber(accel[1]));
  setText("accel-z", formatNumber(accel[2]));
  setText("gyro-x", formatNumber(gyro[0], 3));
  setText("gyro-y", formatNumber(gyro[1], 3));
  setText("gyro-z", formatNumber(gyro[2], 3));
  setMetric("imu-temperature", "imu-temperature-state", imu.temperature_c, 2);

  const imuLive = [...accel, ...gyro, imu.temperature_c].some(isFiniteNumber);
  setTag(elements.imuState, imuLive ? "LIVE" : "NO DATA", imuLive ? "good" : "warn");
}

function formatAngle(value) {
  return isFiniteNumber(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}°` : "--";
}

function formatBias(vector) {
  if (!vector) return "--, --, --";
  return [vector.x, vector.y, vector.z].map((value) => formatNumber(value, 3)).join(", ");
}

function trackMqttMessage() {
  const now = Date.now();
  mqttPacketTimes = mqttPacketTimes.filter((time) => now - time <= 5000);
  mqttPacketTimes.push(now);
  const spanSeconds = mqttPacketTimes.length > 1
    ? Math.min(5, (now - mqttPacketTimes[0]) / 1000)
    : 1;
  mqttRate = mqttPacketTimes.length / Math.max(1, spanSeconds);
}

function renderDiagnostics(state) {
  if (!elements.debugMqttRate) return;
  elements.debugMqttRate.textContent = `${mqttRate.toFixed(2)} msg/s`;
  elements.debugSampleAge.textContent = state.freshnessMs === null
    ? "--"
    : `${(state.freshnessMs / 1000).toFixed(2)} s`;
  elements.debugPacketInterval.textContent = `${formatNumber(state.sampleIntervalMs, 0)} ms`;
  elements.debugAngles.textContent = `${formatAngle(state.pitch)} / ${formatAngle(state.roll)} / ${formatAngle(state.yaw)}`;
  elements.debugGyroBias.textContent = formatBias(state.gyroBias);
  elements.debugMotion.textContent = !state.sensorValid
    ? "UNKNOWN"
    : state.biasCalibrating
      ? "CALIBRATING BIAS"
      : state.stationary
        ? "STATIONARY"
        : "MOVING";
  elements.debugFps.textContent = String(Math.round(state.fps || 0));
  elements.debugValidity.textContent = state.sensorValid ? "VALID" : "INVALID";
}

function renderAttitudeState(state) {
  if (!elements.attitudeState) return;
  const tone = state.status === "LIVE"
    ? "good"
    : state.status.includes("UNAVAILABLE") || state.status.includes("DISABLED")
      ? "error"
      : "warn";
  setTag(elements.attitudeState, state.status, tone);
  setTag(elements.attitudeCalibrationState, state.calibrationStatus, state.calibrated ? "good" : "warn");
  elements.attitudePitch.textContent = formatAngle(state.pitch);
  elements.attitudeRoll.textContent = formatAngle(state.roll);
  elements.attitudeYaw.textContent = formatAngle(state.yaw);
  elements.attitudeFreshness.textContent = state.freshnessMs === null
    ? "No live sample"
    : `${(state.freshnessMs / 1000).toFixed(1)} s since live IMU sample`;
  elements.attitudeTracking.checked = state.tracking;
  renderDiagnostics(state);
}

function updateAttitudeFromPayload(data) {
  if (!attitudeView) return;
  const imu = data.mpu6050 ?? {};
  const accel = Array.isArray(imu.accel_m_s2) ? imu.accel_m_s2 : [];
  const gyro = Array.isArray(imu.gyro_rad_s) ? imu.gyro_rad_s : [];
  const hasImu = accel.length >= 3 && gyro.length >= 3 && [...accel.slice(0, 3), ...gyro.slice(0, 3)].every(isFiniteNumber);
  if (hasImu) attitudeView.update(accel, gyro, data.uptime_ms);
  else attitudeView.markInvalidSample();
}

function initAttitude() {
  const container = document.getElementById("attitude-view");
  if (!window.RocketAttitudeView || !container) {
    setTag(elements.attitudeState, "ATTITUDE VIEW UNAVAILABLE", "error");
    setTag(elements.attitudeCalibrationState, "NOT CALIBRATED", "warn");
    logEntry("3D attitude view unavailable: Three.js or OrbitControls did not load.", "error");
    return;
  }

  try {
    attitudeView = new RocketAttitudeView({
      container,
      onState: renderAttitudeState,
      onEvent: (message) => logEntry(message, "info")
    });
  } catch (error) {
    setTag(elements.attitudeState, "ATTITUDE VIEW UNAVAILABLE", "error");
    setTag(elements.attitudeCalibrationState, "NOT CALIBRATED", "warn");
    logEntry(`3D attitude view failed to initialize: ${error?.message || "unknown error"}`, "error");
  }
}

function renderGps(data) {
  const gps = data.gps ?? {};
  const valid = gps.valid === true;
  setTag(elements.gpsState, valid ? "FIX ACQUIRED" : "WAITING FOR GPS FIX", valid ? "good" : "warn");
  elements.gpsWarning.hidden = valid;
  setText("gps-latitude", valid ? formatNumber(gps.lat, 6) : "--");
  setText("gps-longitude", valid ? formatNumber(gps.lon, 6) : "--");
  setText("gps-altitude", valid ? formatNumber(gps.altitude_m, 2) : "--");
  setText("gps-satellites", isFiniteNumber(gps.satellites) ? String(gps.satellites) : "--");
}

function pushSeries(name, value) {
  const series = history[name];
  series.push(isFiniteNumber(value) ? value : null);
  if (series.length > HISTORY_LIMIT) series.shift();
}

function pushChartSample(data) {
  const bmp = data.bmp280 ?? {};
  const imu = data.mpu6050 ?? {};
  const accel = Array.isArray(imu.accel_m_s2) ? imu.accel_m_s2 : [];

  history.labels.push(nowText());
  if (history.labels.length > HISTORY_LIMIT) history.labels.shift();

  pushSeries("altitude", bmp.altitude_m);
  pushSeries("temperature", bmp.temperature_c);
  pushSeries("accelX", accel[0]);
  pushSeries("accelY", accel[1]);
  pushSeries("accelZ", accel[2]);
}

function createChart(canvasId, datasets, yTitle) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return null;

  return new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: history.labels,
      datasets: datasets.map((dataset) => ({
        label: dataset.label,
        data: history[dataset.key],
        borderColor: dataset.color,
        backgroundColor: `${dataset.color}22`,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.25,
        spanGaps: true
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "#71869d", font: { family: "DM Mono", size: 9 }, maxTicksLimit: 6 }
        },
        y: {
          grid: { color: "rgba(126, 151, 180, 0.12)" },
          ticks: { color: "#71869d", font: { family: "DM Mono", size: 9 } },
          title: { display: Boolean(yTitle), text: yTitle, color: "#71869d", font: { family: "DM Sans", size: 10 } }
        }
      },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: "#a9bdd1", boxWidth: 10, boxHeight: 2, font: { family: "DM Mono", size: 10 } }
        },
        tooltip: {
          backgroundColor: "#0b1626",
          borderColor: "#20334b",
          borderWidth: 1,
          titleColor: "#d9e7f5",
          bodyColor: "#b9cde0"
        }
      }
    }
  });
}

function initCharts() {
  if (typeof Chart === "undefined") {
    console.error("Chart.js failed to load; telemetry values will still update.");
    return;
  }

  charts.altitude = createChart("altitude-chart", [
    { key: "altitude", label: "Altitude", color: "#56e39f" }
  ], "m");

  charts.temperature = createChart("temperature-chart", [
    { key: "temperature", label: "Temperature", color: "#ffbe6b" }
  ], "°C");

  charts.accelerometer = createChart("accelerometer-chart", [
    { key: "accelX", label: "X", color: "#ff7b89" },
    { key: "accelY", label: "Y", color: "#56e39f" },
    { key: "accelZ", label: "Z", color: "#5b9dff" }
  ], "m/s²");
}

function updateCharts() {
  Object.values(charts).forEach((chart) => chart?.update("none"));
}

function logEntry(label, tone = "info", raw = null) {
  const empty = elements.log.querySelector(".log-empty");
  if (empty) empty.remove();

  const item = document.createElement("li");
  item.className = "log-entry";
  item.dataset.tone = tone;

  const head = document.createElement("div");
  head.className = "log-entry-head";
  const time = document.createElement("time");
  time.textContent = nowText();
  const message = document.createElement("span");
  message.textContent = label;
  head.append(time, message);
  item.append(head);

  if (raw) {
    const code = document.createElement("code");
    code.textContent = raw;
    item.append(code);
  }

  elements.log.prepend(item);
  while (elements.log.children.length > LOG_LIMIT) {
    elements.log.lastElementChild.remove();
  }
}

function summarize(data) {
  const bmp = data.bmp280 ?? {};
  const imu = data.mpu6050 ?? {};
  const accel = Array.isArray(imu.accel_m_s2) ? imu.accel_m_s2 : [];
  return [
    `uptime=${formatNumber(data.uptime_ms, 0)} ms`,
    `temp=${formatNumber(bmp.temperature_c)} C`,
    `alt=${formatNumber(bmp.altitude_m)} m`,
    `accel=[${accel.map((value) => formatNumber(value)).join(", ")}]`,
    `gps=${data.gps?.valid === true ? "FIX" : "NO FIX"}`
  ].join(" | ");
}

function renderTelemetry(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    logEntry("Malformed telemetry packet ignored", "error", text.slice(0, 500));
    return;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    logEntry("Invalid telemetry packet ignored", "error", text.slice(0, 500));
    return;
  }

  if (data.device && data.device !== "rocket-001") {
    logEntry(`Unexpected device id: ${data.device}`, "warn");
  }

  packetCount += 1;
  trackMqttMessage();
  elements.packetCount.textContent = String(packetCount);
  elements.lastMessageTime.textContent = nowText();
  elements.telemetry.textContent = JSON.stringify(data, null, 2);

  renderBmp(data.bmp280 ?? {});
  renderImu(data);
  updateAttitudeFromPayload(data);
  renderGps(data);
  pushChartSample(data);
  updateCharts();
  logEntry("Telemetry packet received", "info", summarize(data));
}

function connect() {
  if (client || connecting) return;

  if (typeof mqtt === "undefined") {
    setConnection("error", "MQTT LIBRARY UNAVAILABLE", "mqtt.js did not load. Check the network connection and reload.", "error");
    return;
  }

  const username = elements.username.value.trim();
  const password = elements.password.value;
  if (!username || !password) {
    setConnection("error", "CREDENTIALS REQUIRED", "Enter the dashboard username and password before connecting.", "error");
    return;
  }

  credentials = { username, password };
  elements.password.value = "";
  connecting = true;
  manualDisconnect = false;
  subscribed = false;
  const token = ++connectionToken;
  setConnection("connecting", "CONNECTING", `Opening secure WebSocket to ${BROKER_URL}`, "ok");
  setSubscription("NOT SUBSCRIBED", "muted");
  setButtons();

  client = mqtt.connect(BROKER_URL, {
    username: credentials.username,
    password: credentials.password,
    clientId: `rocket_dashboard_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
    connectTimeout: 10000
  });

  client.on("connect", () => {
    if (token !== connectionToken) return;
    connecting = false;
    subscribed = false;
    setConnection("connecting", "SUBSCRIBING", `Connected. Subscribing to ${TOPIC}`, "ok");
    setSubscription("SUBSCRIBING", "warn");
    setButtons();

    client.subscribe(TOPIC, { qos: 0 }, (error) => {
      if (token !== connectionToken) return;
      if (error) {
        setConnection("error", "SUBSCRIPTION FAILED", error.message || "Unable to subscribe to telemetry topic.", "error");
        setSubscription("SUBSCRIPTION ERROR", "error");
        logEntry(`Subscription failed: ${error.message || "unknown error"}`, "error");
        manualDisconnect = true;
        client.end(true);
        client = null;
        credentials = null;
        subscribed = false;
        connecting = false;
        setButtons();
        return;
      }

      subscribed = true;
      setConnection("online", "CONNECTED", `Subscribed to ${TOPIC}.`, "ok");
      setSubscription("SUBSCRIBED", "good");
      logEntry("MQTT connected and telemetry subscription active", "info");
      setButtons();
    });
  });

  client.on("message", (topic, payload) => {
    if (token !== connectionToken || topic !== TOPIC) return;
    renderTelemetry(payload.toString());
  });

  client.on("reconnect", () => {
    if (token !== connectionToken) return;
    subscribed = false;
    setSubscription("NOT SUBSCRIBED", "muted");
    setConnection("connecting", "RECONNECTING", "Connection dropped. Retrying automatically.", "ok");
    setButtons();
  });

  client.on("error", (error) => {
    if (token !== connectionToken) return;
    const detail = error?.message || "Unknown MQTT error";
    setConnection("error", "CONNECTION ERROR", detail, "error");
    logEntry(`MQTT error: ${detail}`, "error");
    setButtons();
  });

  client.on("close", () => {
    if (token !== connectionToken) return;
    subscribed = false;
    connecting = false;
    setSubscription("NOT SUBSCRIBED", "muted");
    if (manualDisconnect) {
      setConnection("offline", "OFFLINE", "Disconnected.", "ok");
    } else {
      setConnection("connecting", "RECONNECTING", "Link closed. Retrying automatically.", "ok");
    }
    setButtons();
  });
}

function disconnect() {
  connectionToken += 1;
  manualDisconnect = true;
  connecting = false;
  subscribed = false;

  if (client) {
    client.end(true);
    client = null;
  }

  credentials = null;
  elements.password.value = "";
  setConnection("offline", "OFFLINE", "Disconnected by operator.", "ok");
  setSubscription("NOT SUBSCRIBED", "muted");
  logEntry("Disconnected by operator", "warn");
  setButtons();
}

function clearLog() {
  elements.log.replaceChildren();
  const item = document.createElement("li");
  item.className = "log-empty";
  item.textContent = "Log cleared.";
  elements.log.append(item);
}

elements.connectButton.addEventListener("click", connect);
elements.disconnectButton.addEventListener("click", disconnect);
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});
elements.clearLog.addEventListener("click", clearLog);
elements.attitudeCalibrate.addEventListener("click", () => attitudeView?.calibrateFromCurrent());
elements.attitudeReset.addEventListener("click", () => attitudeView?.clearCalibration());
elements.cameraReset.addEventListener("click", () => attitudeView?.resetCamera());
elements.attitudeTracking.addEventListener("change", (event) => attitudeView?.setTracking(event.target.checked));

window.addEventListener("beforeunload", () => {
  credentials = null;
  elements.password.value = "";
  attitudeView?.dispose();
});

initCharts();
initAttitude();
setButtons();
