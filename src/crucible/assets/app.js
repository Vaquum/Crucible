const channels = ["x", "y", "color", "size"];
const fieldIds = ["xField", "yField", "colorField", "sizeField"];
const scaleIds = ["xScale", "yScale", "colorScale", "sizeScale"];
const outlierIds = ["xOutlier", "yOutlier", "colorOutlier", "sizeOutlier"];
const ids = [
  ...fieldIds, ...scaleIds, ...outlierIds,
  "datasetToggle", "datasetLabel", "datasetModal", "datasetClose", "sourcePanel",
  "dateToggle", "datePanel", "start", "end", "fraction",
  "timelinePlay", "timelinePlayIcon", "timeline", "timelineSpeed",
  "status", "chart", "tooltip",
];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
el.datePresetButtons = Array.from(document.querySelectorAll("[data-date-preset]"));
el.sourceCardButtons = Array.from(document.querySelectorAll("[data-source-card]"));
const ctx = el.chart.getContext("2d", { alpha: false });
const FONT_SANS = '"IBM Plex Sans", system-ui, sans-serif';
const FONT_MONO = '"IBM Plex Mono", monospace';
const Z_SCORE_LIMIT = 3;

let THEME = null;
let endpoints = {};
let datasetRef = null;
let columnKind = {};
let meta = null;
let latest;
let activeRequest;
let debounce;
let datasetStepMs = 0;
let availableStart;
let availableEnd;
let timelineDomainStart;
let timelineDomainEnd;
let playTimer;
let timelineSyncing = false;
let timelineBrushing = false;
let timelineBrushTimer;
let lastTimelineValue = "";

// ---- dataset selection ----

function refParams(ref = datasetRef) {
  const params = new URLSearchParams({ source: ref.source });
  if (ref.source === "klines") params.set("series", ref.series);
  if (ref.source === "sweep") { params.set("experiment", ref.experiment); params.set("round", ref.round); }
  if (ref.source === "upload") params.set("upload", ref.upload);
  return params;
}

function datasetLabelText(ref) {
  if (ref.source === "klines") return `klines · ${ref.series}`;
  if (ref.source === "sweep") return `sweep · ${ref.experiment} · r${ref.round}`;
  return `upload · ${ref.upload}`;
}

function openModal() {
  el.datasetModal.classList.add("open");
  el.datasetModal.setAttribute("aria-hidden", "false");
  el.datasetToggle.classList.add("active");
}

function closeModal() {
  el.datasetModal.classList.remove("open");
  el.datasetModal.setAttribute("aria-hidden", "true");
  el.datasetToggle.classList.remove("active");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function selectCard(source) {
  el.sourceCardButtons.forEach((button) => button.classList.toggle("active", button.dataset.sourceCard === source));
  if (source === "klines") renderKlinesPicker();
  else if (source === "sweep") renderSweepPicker();
  else renderUploadPicker();
}

async function renderKlinesPicker() {
  el.sourcePanel.replaceChildren(message("Loading series…"));
  const { series } = await getJson(endpoints.klines || "api/klines");
  if (series.length === 0) { el.sourcePanel.replaceChildren(message("No klines series under the arrow root.")); return; }
  const types = [...new Set(series.map((entry) => entry.bar_type))];
  const typeSelect = selectFrom(types.map((type) => [type, type]));
  const intervalSelect = document.createElement("select");
  const syncIntervals = () => {
    const intervals = series.filter((entry) => entry.bar_type === typeSelect.value);
    intervalSelect.replaceChildren(...intervals.map((entry) => new Option(entry.interval, entry.series)));
  };
  typeSelect.addEventListener("change", syncIntervals);
  syncIntervals();
  const load = primaryButton("Load", () => selectDataset({ source: "klines", series: intervalSelect.value }));
  el.sourcePanel.replaceChildren(pickerRow([labelled("Bar", typeSelect), labelled("Interval", intervalSelect), load]));
}

async function renderSweepPicker() {
  el.sourcePanel.replaceChildren(message("Loading sweep results…"));
  const { experiments } = await getJson(endpoints.sweeps || "api/sweeps");
  if (experiments.length === 0) { el.sourcePanel.replaceChildren(message("No sweep results under the experiments root.")); return; }
  const tree = document.createElement("div");
  tree.className = "tree";
  for (const experiment of experiments) {
    const node = document.createElement("div");
    node.className = "tree-exp";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tree-exp-head";
    const caret = document.createElement("span");
    caret.className = "caret t-icon";
    caret.textContent = "▶";
    const expName = document.createElement("span");
    expName.textContent = experiment.experiment;
    const expCount = document.createElement("span");
    expCount.className = "source-card-note";
    expCount.textContent = String(experiment.rounds.length);
    head.append(caret, expName, expCount);
    head.addEventListener("click", () => {
      const open = node.classList.toggle("open");
      head.querySelector(".caret").textContent = open ? "▼" : "▶";
    });
    const rounds = document.createElement("div");
    rounds.className = "tree-rounds";
    for (const round of experiment.rounds) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tree-round";
      button.textContent = `r${round}`;
      button.addEventListener("click", () => selectDataset({ source: "sweep", experiment: experiment.experiment, round }));
      rounds.append(button);
    }
    node.append(head, rounds);
    tree.append(node);
  }
  el.sourcePanel.replaceChildren(tree);
}

async function renderUploadPicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.parquet";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const url = `${endpoints.upload || "api/upload"}?filename=${encodeURIComponent(file.name)}`;
    const response = await fetch(url, { method: "POST", body: file });
    if (!response.ok) { el.status.value = await response.text(); return; }
    const { upload } = await response.json();
    selectDataset({ source: "upload", upload });
  });
  const { uploads } = await getJson(endpoints.uploads || "api/uploads");
  const list = document.createElement("div");
  list.className = "upload-list";
  for (const name of uploads) {
    const item = document.createElement("div");
    item.className = "upload-item";
    const open = document.createElement("span");
    open.className = "upload-name";
    open.textContent = name;
    open.addEventListener("click", () => selectDataset({ source: "upload", upload: name }));
    item.append(open);
    list.append(item);
  }
  el.sourcePanel.replaceChildren(pickerRow([input]), uploads.length ? list : message("No uploads yet."));
}

function message(text) { const div = document.createElement("div"); div.className = "picker-empty"; div.textContent = text; return div; }
function selectFrom(options) { const select = document.createElement("select"); select.replaceChildren(...options.map(([value, text]) => new Option(text, value))); return select; }
function labelled(text, control) { const label = document.createElement("label"); const span = document.createElement("span"); span.textContent = text; label.append(span, control); return label; }
function pickerRow(children) { const row = document.createElement("div"); row.className = "picker-row"; row.append(...children); return row; }
function primaryButton(text, handler) { const button = document.createElement("button"); button.type = "button"; button.className = "primary"; button.textContent = text; button.addEventListener("click", handler); return button; }

async function selectDataset(ref) {
  datasetRef = ref;
  el.datasetLabel.value = datasetLabelText(ref);
  closeModal();
  el.status.value = "Loading";
  try {
    meta = await getJson(`${endpoints.meta || "api/meta"}?${refParams(ref).toString()}`);
  } catch (error) {
    el.status.value = error.message;
    return;
  }
  setupColumns();
  setupTime();
  resize();
  run();
}

function setupColumns() {
  columnKind = Object.fromEntries(meta.columns.map((column) => [column.name, column.kind]));
  const ordered = [
    ...meta.columns.filter((column) => column.kind === "numeric"),
    ...meta.columns.filter((column) => column.kind === "categorical"),
  ].map((column) => column.name);
  fieldIds.forEach((id) => el[id].replaceChildren(...meta.columns.map((column) => new Option(column.name, column.name))));
  fieldIds.forEach((id, index) => { el[id].value = ordered[Math.min(index, ordered.length - 1)] || ordered[0]; });
  scaleIds.forEach((id) => { el[id].checked = false; });
  outlierIds.forEach((id) => { el[id].checked = false; });
  updateChannelToggles();
}

function updateChannelToggles() {
  channels.forEach((channel) => {
    const categorical = columnKind[el[`${channel}Field`].value] === "categorical";
    const scale = el[`${channel}Scale`];
    const outlier = el[`${channel}Outlier`];
    scale.disabled = categorical;
    outlier.disabled = categorical;
    if (categorical) { scale.checked = false; outlier.checked = false; }
  });
}

function setupTime() {
  const hasTime = Boolean(meta.time_column && meta.start && meta.end);
  document.body.classList.toggle("no-time", !hasTime);
  if (!hasTime) { availableStart = availableEnd = timelineDomainStart = timelineDomainEnd = undefined; return; }
  availableStart = parseInputTime(meta.start);
  availableEnd = parseInputTime(meta.end);
  setTimelineDomain(availableStart, availableEnd);
  el.start.value = inputTime(timelineDomainStart);
  el.end.value = inputTime(timelineDomainEnd);
  datasetStepMs = Math.max(1, Math.round((availableEnd.getTime() - availableStart.getTime()) / 300));
  syncTimelineFromDates();
}

// ---- time helpers ----

function parseInputTime(value) { return new Date(`${value}Z`); }
function inputTime(value) { const iso = value.toISOString(); return iso.slice(20, 23) === "000" ? iso.slice(0, 19) : iso.slice(0, 23); }
function hourStart(value) { const result = new Date(value); result.setUTCMinutes(0, 0, 0); return result; }
function blockStepMs() { return Math.max(1, datasetStepMs); }

function setDateRange(start, end, delay = 75) {
  if (availableStart && start < availableStart) start = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  if (start >= end) return;
  el.start.value = inputTime(start);
  el.end.value = inputTime(end);
  syncTimelineFromDates();
  schedule(delay);
}

function setTimelineDomain(start, end) {
  if (availableStart && start < availableStart) start = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  if (start >= end) return false;
  timelineDomainStart = start;
  timelineDomainEnd = end;
  return true;
}

function updateTimelineDomainFromInputs() {
  return setTimelineDomain(parseInputTime(el.start.value), parseInputTime(el.end.value));
}

function timelineMaxStep(stepMs = blockStepMs()) {
  if (!timelineDomainStart || !timelineDomainEnd) return 0;
  return Math.max(0, Math.ceil((timelineDomainEnd.getTime() - timelineDomainStart.getTime()) / stepMs) - 1);
}

function timelineStepForEnd(end, stepMs = blockStepMs()) {
  if (!timelineDomainStart) return 0;
  return Math.max(0, Math.ceil((end.getTime() - timelineDomainStart.getTime()) / stepMs) - 1);
}

function timelineRangeForStep(stepIndex) {
  if (!timelineDomainStart || !timelineDomainEnd) return null;
  const stepMs = blockStepMs();
  const maxStep = timelineMaxStep(stepMs);
  const clampedStep = Math.min(Math.max(0, stepIndex), maxStep);
  const end = new Date(Math.min(timelineDomainEnd.getTime(), timelineDomainStart.getTime() + (clampedStep + 1) * stepMs));
  return { start: timelineDomainStart, end, maxStep };
}

function syncTimelineFromDates() {
  if (!timelineDomainStart || !timelineDomainEnd) return;
  const stepMs = blockStepMs();
  const maxStep = timelineMaxStep(stepMs);
  const stepIndex = Math.min(timelineStepForEnd(parseInputTime(el.end.value), stepMs), maxStep);
  timelineSyncing = true;
  el.timeline.min = "0";
  el.timeline.max = String(maxStep);
  el.timeline.step = "1";
  el.timeline.value = String(stepIndex);
  el.timeline.disabled = maxStep === 0;
  el.timelinePlay.disabled = maxStep === 0;
  if (maxStep === 0 && playTimer) setPlaying(false);
  timelineSyncing = false;
}

function setRangeFromTimeline(delay = 0) {
  if (timelineSyncing || !timelineDomainStart || !timelineDomainEnd) return;
  const range = timelineRangeForStep(Number(el.timeline.value));
  if (range) setDateRange(range.start, range.end, delay);
}

function playbackDelayMs() { return Math.max(31, 1000 / Math.max(1, Number(el.timelineSpeed.value) || 1)); }

function playbackStepCount() {
  const maxStep = Number(el.timeline.max);
  const width = el.timeline.getBoundingClientRect().width;
  if (!Number.isFinite(maxStep) || maxStep <= 0 || !Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.ceil(maxStep / width));
}

function timelineBrushLoop() {
  if (!timelineBrushing) return;
  if (el.timeline.value !== lastTimelineValue) { lastTimelineValue = el.timeline.value; setRangeFromTimeline(0); }
  timelineBrushTimer = setTimeout(timelineBrushLoop, 16);
}

function startTimelineBrush() { if (timelineBrushing) return; setPlaying(false); timelineBrushing = true; lastTimelineValue = ""; timelineBrushLoop(); }
function stopTimelineBrush() { timelineBrushing = false; if (timelineBrushTimer) { clearTimeout(timelineBrushTimer); timelineBrushTimer = undefined; } }

function advanceTimelineStep() {
  const next = Number(el.timeline.value) + playbackStepCount();
  if (next > Number(el.timeline.max)) { setPlaying(false); return false; }
  el.timeline.value = String(next);
  setRangeFromTimeline(0);
  return true;
}

function playLoop() { if (!playTimer) return; if (!advanceTimelineStep()) return; playTimer = setTimeout(playLoop, playbackDelayMs()); }

function setPlaying(playing) {
  if (playTimer) { clearTimeout(playTimer); playTimer = undefined; }
  el.timelinePlay.setAttribute("aria-pressed", String(playing));
  el.timelinePlay.setAttribute("aria-label", playing ? "Pause timeline" : "Play timeline");
  el.timelinePlay.title = playing ? "Pause timeline" : "Play timeline";
  el.timelinePlayIcon.textContent = playing ? "Ⅱ" : "▶";
  if (!playing) return;
  if (Number(el.timeline.value) >= Number(el.timeline.max)) { el.timeline.value = "0"; setRangeFromTimeline(0); }
  if (!advanceTimelineStep()) return;
  playTimer = setTimeout(playLoop, playbackDelayMs());
}

function applyDatePreset(preset) {
  if (!availableEnd) return;
  const end = new Date(availableEnd);
  const currentHourStart = hourStart(new Date(end.getTime() - 1));
  let start;
  let stop = end;
  if (preset === "current-hour") { start = currentHourStart; if (start >= end) start = new Date(end.getTime() - 3600000); }
  else if (preset === "last-hour") { stop = currentHourStart; start = new Date(stop.getTime() - 3600000); }
  else if (preset === "last-4-hours") { stop = currentHourStart; start = new Date(stop.getTime() - 4 * 3600000); }
  else return;
  if (setTimelineDomain(start, stop)) setDateRange(timelineDomainStart, timelineDomainEnd);
  el.datePanel.hidden = true;
}

function clampedRange() {
  let start = parseInputTime(el.start.value);
  let end = parseInputTime(el.end.value);
  if (availableStart && start < availableStart) start = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  if (start >= end) { start = availableStart; end = availableEnd; }
  el.start.value = inputTime(start);
  el.end.value = inputTime(end);
  return { start: inputTime(start), end: inputTime(end) };
}

// ---- request ----

function scatterQs() {
  const params = refParams();
  fieldIds.forEach((id, index) => params.set(channels[index], el[id].value));
  params.set("fraction", el.fraction.value);
  if (meta && meta.time_column) {
    const range = clampedRange();
    params.set("start", range.start);
    params.set("end", range.end);
  }
  return params.toString();
}

async function run() {
  if (!datasetRef) return;
  if (activeRequest) activeRequest.abort();
  const request = new AbortController();
  activeRequest = request;
  el.status.value = "Loading";
  try {
    const response = await fetch(`${endpoints.scatter || "api/scatter"}?${scatterQs()}`, { signal: request.signal });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (activeRequest !== request) return;
    latest = data;
    el.status.value = statusText(latest);
    draw();
  } catch (error) {
    if (activeRequest === request && error.name !== "AbortError") el.status.value = error.message;
  } finally {
    if (activeRequest === request) activeRequest = undefined;
  }
}

function schedule(delay = 75) { clearTimeout(debounce); debounce = setTimeout(run, delay); }

function statusText(data) {
  const display = filteredScatterData(data);
  const active = activeOutlierChannels();
  const zText = active.length > 0 ? ` | z ${active.join(",")}` : "";
  return `${datasetLabelText(datasetRef)}${zText} | rows ${data.rows.toLocaleString()} | points ${data.points.toLocaleString()} | shown ${display.shown.toLocaleString()} | ${data.elapsed_ms} ms`;
}

// ---- canvas theme ----

function hexRgb(hex) { const h = hex.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

function theme() {
  if (THEME) return THEME;
  const css = getComputedStyle(document.documentElement);
  const value = (name) => css.getPropertyValue(name).trim();
  THEME = {
    bg: value("--c-near-black"), fg2: value("--c-light-gray"),
    gridMajor: value("--c-dark-gray"), gridMinor: value("--c-warm-black"), tick: value("--c-mid-gray"),
    rampLo: hexRgb(value("--c-lavender")), rampHi: hexRgb(value("--c-coral")),
  };
  return THEME;
}

function clamp01(value) { if (!Number.isFinite(value)) return 0; return Math.max(0, Math.min(1, value)); }
function colorFor(t) {
  const { rampLo, rampHi } = theme();
  const u = clamp01(t);
  const r = Math.round(rampLo[0] + (rampHi[0] - rampLo[0]) * u);
  const g = Math.round(rampLo[1] + (rampHi[1] - rampLo[1]) * u);
  const b = Math.round(rampLo[2] + (rampHi[2] - rampLo[2]) * u);
  return `rgba(${r}, ${g}, ${b}, 0.55)`;
}

// ---- outlier filter (client side) ----

function controlScale(id) { return el[id].checked ? "log" : "linear"; }
function outlierEnabled(channel) { return el[`${channel}Outlier`].checked; }
function activeOutlierChannels() { return channels.filter((channel) => outlierEnabled(channel) && !el[`${channel}Outlier`].disabled); }

function zStats(values) {
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  let squared = 0;
  for (const value of values) squared += (value - mean) ** 2;
  return { mean, std: Math.sqrt(squared / values.length) };
}

function zKeep(value, stats) { if (!stats || stats.std === 0) return true; return Math.abs((value - stats.mean) / stats.std) <= Z_SCORE_LIMIT; }

function filteredScatterData(data) {
  if (data.outlierFiltered) return data;
  const active = activeOutlierChannels();
  if (active.length === 0) return data;
  const stats = Object.fromEntries(active.map((channel) => [channel, zStats(data[channel])]));
  const kept = { x: [], y: [], color: [], size: [] };
  for (let index = 0; index < data.x.length; index += 1) {
    if (active.every((channel) => zKeep(data[channel][index], stats[channel]))) {
      channels.forEach((channel) => kept[channel].push(data[channel][index]));
    }
  }
  const result = { ...data, ...kept, shown: kept.x.length, outlierFiltered: true };
  if (kept.x.length > 0) {
    channels.forEach((channel) => {
      result[`${channel}_min`] = Math.min(...kept[channel]);
      result[`${channel}_max`] = Math.max(...kept[channel]);
    });
  }
  return result;
}

// ---- scales ----

function domain(min, max) { return min === max ? { min: min - 0.5, max: max + 0.5 } : { min, max }; }
function scaleType(scale) { return typeof scale === "string" ? scale : scale.type; }
function scaleConfig(scale, rawDomain) {
  if (scale !== "log") return { type: scale };
  if (rawDomain.min > 0) return { type: "log-positive" };
  if (rawDomain.max < 0) return { type: "log-negative" };
  const maxAbs = Math.max(Math.abs(rawDomain.min), Math.abs(rawDomain.max));
  return { type: "symlog", constant: Math.max(maxAbs / 100, Number.MIN_VALUE) };
}
function scaleValue(value, scale) {
  const type = scaleType(scale);
  if (type === "log-positive") return Math.log10(Math.max(value, Number.MIN_VALUE));
  if (type === "log-negative") return -Math.log10(Math.max(-value, Number.MIN_VALUE));
  if (type === "symlog") return Math.sign(value) * Math.log10(1 + Math.abs(value) / scale.constant);
  return value;
}
function inverseScaleValue(value, scale) {
  const type = scaleType(scale);
  if (type === "log-positive") return 10 ** value;
  if (type === "log-negative") return -(10 ** -value);
  if (type === "symlog") return Math.sign(value) * scale.constant * (10 ** Math.abs(value) - 1);
  return value;
}
function cleanValue(value) { const cleaned = Number(value.toPrecision(12)); return Object.is(cleaned, -0) ? 0 : cleaned; }
function scaledDomain(rawDomain, scale) { return domain(scaleValue(rawDomain.min, scale), scaleValue(rawDomain.max, scale)); }
function scaledPosition(value, scaled, scale) { const width = scaled.max - scaled.min; return width === 0 ? 0.5 : (scaleValue(value, scale) - scaled.min) / width; }

function niceStep(span, targetIntervals) {
  const raw = span / Math.max(1, targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const choices = [1, 2, 2.5, 5, 10].map((item) => item * magnitude);
  return choices.reduce((best, item) => (Math.abs(Math.log(item / raw)) < Math.abs(Math.log(best / raw)) ? item : best), choices[0]);
}
function nextNiceStep(step) {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const ratio = step / magnitude;
  if (ratio < 2) return 2 * magnitude;
  if (ratio < 2.5) return 2.5 * magnitude;
  if (ratio < 5) return 5 * magnitude;
  if (ratio < 10) return 10 * magnitude;
  return 20 * magnitude;
}
function cleanTick(value, step) {
  const digits = Math.min(12, Math.max(0, 6 - Math.floor(Math.log10(step))));
  return cleanValue(Number(value.toFixed(digits)));
}
function fixedAxis(rawDomain, count) {
  let step = niceStep((rawDomain.max - rawDomain.min) / Math.max(1, count - 1), 1);
  let start = Math.floor(rawDomain.min / step) * step;
  while (start + step * (count - 1) < rawDomain.max) { step = nextNiceStep(step); start = Math.floor(rawDomain.min / step) * step; }
  return Array.from({ length: count }, (_, index) => cleanTick(start + index * step, step));
}
function boundedTicks(rawDomain, count) {
  let step = niceStep((rawDomain.max - rawDomain.min) / Math.max(1, count - 1), 1);
  let ticks = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    ticks = [];
    const start = Math.ceil(rawDomain.min / step) * step;
    const stop = Math.floor(rawDomain.max / step) * step;
    for (let value = start; value <= stop + step * 0.5; value += step) ticks.push(cleanTick(value, step));
    if (ticks.length <= count + 2) break;
    step = nextNiceStep(step);
  }
  if (!ticks.includes(rawDomain.min)) ticks.unshift(rawDomain.min);
  if (!ticks.includes(rawDomain.max)) ticks.push(rawDomain.max);
  return Array.from(new Set(ticks)).sort((a, b) => a - b);
}
function axisSpec(rawDomain, scale, count) {
  if (scaleType(scale) !== "linear") {
    const scaled = scaledDomain(rawDomain, scale);
    return { domain: rawDomain, ticks: boundedTicks(scaled, count).map((value) => cleanValue(inverseScaleValue(value, scale))) };
  }
  const ticks = fixedAxis(rawDomain, count);
  return { domain: domain(ticks[0], ticks[ticks.length - 1]), ticks };
}
function midTickValue(left, right, scale) { return inverseScaleValue((scaleValue(left, scale) + scaleValue(right, scale)) / 2, scale); }

function buildAxis(categories, rawMin, rawMax, scaleControl, count) {
  if (categories) {
    const span = Math.max(1, categories.length - 1);
    const dom = { min: -0.5, max: span + 0.5 };
    return { scale: "linear", ticks: categories.map((_, index) => index), domain: dom, categories };
  }
  const rawDomain = domain(rawMin, rawMax);
  const config = scaleConfig(scaleControl, rawDomain);
  const spec = axisSpec(rawDomain, config, count);
  return { scale: config, ticks: spec.ticks, domain: scaledDomain(spec.domain, config), categories: null };
}

// ---- formatting ----

function fmt(value) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.001) return trimFixed(value, 8);
  if (abs < 1) return trimFixed(value, 6);
  return value.toLocaleString(undefined, { maximumFractionDigits: abs >= 100000 ? 2 : 6 });
}
function trimFixed(value, digits) { const text = value.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ""); return text === "-0" ? "0" : text; }
function fmtCompact(value) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trimFixed(value / 1e9, 2)}B`;
  if (abs >= 1e6) return `${trimFixed(value / 1e6, 2)}M`;
  if (abs >= 1e3) return `${trimFixed(value / 1e3, 2)}K`;
  return fmt(value);
}
function truncate(text) { const value = String(text); return value.length > 12 ? `${value.slice(0, 11)}…` : value; }
function axisLabel(field, scale) { return scaleType(scale) === "linear" ? field : `${field} (log)`; }

// ---- canvas ----

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const box = el.chart.getBoundingClientRect();
  el.chart.width = Math.max(1, Math.floor(box.width * ratio));
  el.chart.height = Math.max(1, Math.floor(box.height * ratio));
  draw();
}

function draw() {
  const width = el.chart.width;
  const height = el.chart.height;
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, width, height);
  if (!latest) return;
  drawScatter(latest, width, height);
}

function drawScatter(raw, width, height) {
  const data = filteredScatterData(raw);
  const ratio = window.devicePixelRatio || 1;
  const pad = { left: 72 * ratio, right: 24 * ratio, top: 24 * ratio, bottom: 52 * ratio };
  if (data.shown === 0) {
    ctx.fillStyle = theme().fg2;
    ctx.font = `${12 * ratio}px ${FONT_SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No points after z-score filter", width / 2, height / 2);
    return;
  }
  const compact = width < 360 * ratio;
  const tickCount = compact ? 5 : 9;
  const xa = buildAxis(data.x_categories, data.x_min, data.x_max, controlScale("xScale"), tickCount);
  const ya = buildAxis(data.y_categories, data.y_min, data.y_max, controlScale("yScale"), tickCount);
  const colorScale = data.color_categories ? "linear" : controlScale("colorScale");
  const sizeScale = data.size_categories ? "linear" : controlScale("sizeScale");
  const colorDomain = domain(data.color_min, data.color_max);
  const sizeDomain = domain(data.size_min, data.size_max);
  const colorScaled = scaledDomain(colorDomain, scaleConfig(colorScale, colorDomain));
  const sizeScaled = scaledDomain(sizeDomain, scaleConfig(sizeScale, sizeDomain));
  const colorConfig = scaleConfig(colorScale, colorDomain);
  const sizeConfig = scaleConfig(sizeScale, sizeDomain);
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = Math.max(1, height - pad.top - pad.bottom);
  const left = pad.left;
  const top = pad.top;
  const bottom = top + innerH;
  drawGridTicks(left, top, innerW, innerH, xa, ya, ratio, compact);
  drawZeroAxes(left, top, innerW, innerH, xa, ya, ratio);
  for (let i = 0; i < data.x.length; i += 1) {
    const x = left + scaledPosition(data.x[i], xa.domain, xa.scale) * innerW;
    const y = bottom - scaledPosition(data.y[i], ya.domain, ya.scale) * innerH;
    const colorT = clamp01((scaleValue(data.color[i], colorConfig) - colorScaled.min) / (colorScaled.max - colorScaled.min || 1));
    const sizeT = clamp01((scaleValue(data.size[i], sizeConfig) - sizeScaled.min) / (sizeScaled.max - sizeScaled.min || 1));
    ctx.fillStyle = colorFor(colorT);
    ctx.beginPath();
    ctx.arc(x, y, (1 + 4 * Math.sqrt(sizeT)) * ratio, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = theme().fg2;
  ctx.font = `${12 * ratio}px ${FONT_SANS}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(axisLabel(el.xField.value, xa.scale), left + innerW / 2, height - 8 * ratio);
  ctx.save();
  ctx.translate(18 * ratio, top + innerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(axisLabel(el.yField.value, ya.scale), 0, 0);
  ctx.restore();
}

function shouldLabelTick(ticks, index, compact) {
  if (!compact || ticks.length <= 5) return true;
  if (ticks[index] === 0 || index === 0 || index === ticks.length - 1) return true;
  return index % Math.max(2, Math.ceil(ticks.length / 4)) === 0;
}

function drawGridTicks(left, top, innerW, innerH, xa, ya, ratio, compact) {
  const right = left + innerW;
  const bottom = top + innerH;
  const xLabel = xa.categories ? (value) => truncate(xa.categories[Math.round(value)]) : (compact ? fmtCompact : fmt);
  const yLabel = ya.categories ? (value) => truncate(ya.categories[Math.round(value)]) : (compact ? fmtCompact : fmt);
  ctx.save();
  ctx.strokeStyle = theme().gridMajor;
  ctx.lineWidth = ratio;
  ctx.beginPath();
  for (const value of xa.ticks) { const x = left + scaledPosition(value, xa.domain, xa.scale) * innerW; if (x >= left - 1 && x <= right + 1) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); } }
  for (const value of ya.ticks) { const y = bottom - scaledPosition(value, ya.domain, ya.scale) * innerH; if (y >= top - 1 && y <= bottom + 1) { ctx.moveTo(left, y); ctx.lineTo(right, y); } }
  ctx.stroke();
  ctx.strokeStyle = theme().tick;
  ctx.beginPath();
  for (const value of xa.ticks) { const x = left + scaledPosition(value, xa.domain, xa.scale) * innerW; if (x >= left - 1 && x <= right + 1) { ctx.moveTo(x, bottom); ctx.lineTo(x, bottom + 5 * ratio); } }
  for (const value of ya.ticks) { const y = bottom - scaledPosition(value, ya.domain, ya.scale) * innerH; if (y >= top - 1 && y <= bottom + 1) { ctx.moveTo(left - 5 * ratio, y); ctx.lineTo(left, y); } }
  ctx.stroke();
  ctx.fillStyle = theme().fg2;
  ctx.font = `${(compact ? 9 : 11) * ratio}px ${FONT_MONO}`;
  ctx.textBaseline = "top";
  let lastX = -Infinity;
  xa.ticks.forEach((value, index) => {
    if (!shouldLabelTick(xa.ticks, index, compact)) return;
    const x = left + scaledPosition(value, xa.domain, xa.scale) * innerW;
    if (x < left - 1 || x > right + 1 || x - lastX < (compact ? 36 : 52) * ratio) return;
    ctx.textAlign = index === 0 ? "left" : index === xa.ticks.length - 1 ? "right" : "center";
    ctx.fillText(xLabel(value), x, bottom + 8 * ratio);
    lastX = x;
  });
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const usedY = [];
  ya.ticks.forEach((value, index) => {
    if (!shouldLabelTick(ya.ticks, index, compact)) return;
    const y = bottom - scaledPosition(value, ya.domain, ya.scale) * innerH;
    if (y < top - 1 || y > bottom + 1 || usedY.some((position) => Math.abs(position - y) < 16 * ratio)) return;
    ctx.fillText(yLabel(value), left - 8 * ratio, y);
    usedY.push(y);
  });
  ctx.restore();
}

function drawZeroAxes(left, top, innerW, innerH, xa, ya, ratio) {
  const right = left + innerW;
  const bottom = top + innerH;
  ctx.save();
  ctx.strokeStyle = theme().tick;
  ctx.lineWidth = 1.5 * ratio;
  ctx.setLineDash([5 * ratio, 4 * ratio]);
  if (!xa.categories && xa.domain.min <= 0 && xa.domain.max >= 0) {
    const zeroX = left + scaledPosition(0, xa.domain, xa.scale) * innerW;
    ctx.beginPath(); ctx.moveTo(zeroX, top); ctx.lineTo(zeroX, bottom); ctx.stroke();
  }
  if (!ya.categories && ya.domain.min <= 0 && ya.domain.max >= 0) {
    const zeroY = bottom - scaledPosition(0, ya.domain, ya.scale) * innerH;
    ctx.beginPath(); ctx.moveTo(left, zeroY); ctx.lineTo(right, zeroY); ctx.stroke();
  }
  ctx.restore();
}

// ---- wiring ----

el.datasetToggle.addEventListener("click", openModal);
el.datasetClose.addEventListener("click", closeModal);
el.datasetModal.addEventListener("click", (event) => { if (event.target === el.datasetModal) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && el.datasetModal.classList.contains("open")) closeModal(); });
el.sourceCardButtons.forEach((button) => button.addEventListener("click", () => selectCard(button.dataset.sourceCard)));

el.dateToggle.addEventListener("click", () => { el.datePanel.hidden = !el.datePanel.hidden; });
el.datePresetButtons.forEach((button) => button.addEventListener("click", () => applyDatePreset(button.dataset.datePreset)));

fieldIds.forEach((id) => {
  const handler = () => { updateChannelToggles(); schedule(); };
  el[id].addEventListener("change", handler);
});
["start", "end"].forEach((id) => {
  const handler = () => { setPlaying(false); updateTimelineDomainFromInputs(); syncTimelineFromDates(); schedule(); };
  el[id].addEventListener("input", handler);
  el[id].addEventListener("change", handler);
});
el.fraction.addEventListener("input", schedule);
el.fraction.addEventListener("change", schedule);

el.timeline.addEventListener("pointerdown", startTimelineBrush);
el.timeline.addEventListener("pointerup", stopTimelineBrush);
el.timeline.addEventListener("pointercancel", stopTimelineBrush);
el.timeline.addEventListener("input", () => setRangeFromTimeline(0));
el.timeline.addEventListener("change", () => setRangeFromTimeline(0));
el.timelinePlay.addEventListener("click", () => setPlaying(!playTimer));
el.timelineSpeed.addEventListener("change", () => { if (playTimer) setPlaying(true); });

scaleIds.forEach((id) => el[id].addEventListener("change", draw));
outlierIds.forEach((id) => el[id].addEventListener("change", () => { if (latest) el.status.value = statusText(latest); draw(); }));
window.addEventListener("resize", resize);

fetch("app-config")
  .then((response) => response.json())
  .then((config) => { endpoints = config.endpoints || {}; openModal(); selectCard("klines"); })
  .catch(() => openModal());
