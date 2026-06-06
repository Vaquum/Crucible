const dataIds = ["start", "end", "barType", "barInterval", "barFunction", "xField", "yField", "colorField", "sizeField", "grid", "fraction"];
const channels = ["x", "y", "color", "size"];
const scaleIds = ["xScale", "yScale", "colorScale", "sizeScale"];
const outlierIds = ["xOutlier", "yOutlier", "colorOutlier", "sizeOutlier"];
const ids = [...dataIds, ...scaleIds, ...outlierIds];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const rubricOptions = [
  ["mid", "mid"],
  ["ret_pct", "ret%"],
  ["range_bps", "range_bps"],
  ["trades", "trades"],
  ["turnover", "turnover"],
  ["clip_pct", "clip%"],
  ["med_declip", "med_declip"],
  ["buy_pct", "buy%"],
  ["ofi", "OFI"],
  ["spread_p999", "spread_p999"],
  ["reach20_bps", "reach20_bps"],
  ["depth20_k", "depth20_k"],
  ["abs_imb", "abs_imb"],
  ["flow_mo5s", "flow_mo5s"],
  ["book_mo5s", "book_mo5s"],
  ["div_pct", "div%"],
];
const fieldLabels = Object.fromEntries(rubricOptions);
const unitFields = new Set(["clip_pct", "buy_pct", "abs_imb", "div_pct"]);
const Z_SCORE_LIMIT = 3;
el.dateToggle = document.getElementById("dateToggle");
el.datePanel = document.getElementById("datePanel");
el.datePresetButtons = Array.from(document.querySelectorAll("[data-date-preset]"));
el.timelinePlay = document.getElementById("timelinePlay");
el.timelinePlayIcon = document.getElementById("timelinePlayIcon");
el.timeline = document.getElementById("timeline");
el.timelineSpeed = document.getElementById("timelineSpeed");
el.status = document.getElementById("status");
el.chart = document.getElementById("chart");
el.tooltip = document.getElementById("tooltip");
const ctx = el.chart.getContext("2d", { alpha: false });
const FONT_SANS = '"IBM Plex Sans", system-ui, sans-serif';
const FONT_MONO = '"IBM Plex Mono", monospace';
let THEME = null;
let activeRequest;
let latest;
let debounce;
let availableStart;
let availableEnd;
let timelineDomainStart;
let timelineDomainEnd;
let playTimer;
let timelineSyncing = false;
let timelineBrushing = false;
let timelineBrushTimer;
let lastTimelineValue = "";
const gridFieldCache = new Map();
const groupbyFieldCache = new Map();

function scatterQs(start, end) {
  const params = new URLSearchParams({
    start_datetime: start,
    end_datetime: end,
    bar_type: el.barType.value,
    bar_interval: el.barInterval.value,
    bar_interval_function: el.barFunction.value,
    x_field: el.xField.value,
    y_field: el.yField.value,
    color_field: el.colorField.value,
    size_field: el.sizeField.value,
    fraction: el.fraction.value,
  });
  return params.toString();
}

function parseInputTime(value) {
  return new Date(`${value}Z`);
}

function inputTime(value) {
  const iso = value.toISOString();
  return iso.slice(20, 23) === "000" ? iso.slice(0, 19) : iso.slice(0, 23);
}

function hourStart(value) {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function setDateRange(start, end, delay = 75) {
  if (availableStart && start < availableStart) start = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  if (start >= end) return;
  el.start.value = inputTime(start);
  el.end.value = inputTime(end);
  syncTimelineFromDates();
  schedule(delay);
}

function blockStepMs() {
  return Math.max(1, Math.round(Number(el.barInterval.value) * 1000));
}

function setTimelineDomain(start, end) {
  if (availableStart && start < availableStart) start = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  if (start >= end) return false;
  timelineDomainStart = start;
  timelineDomainEnd = end;
  return true;
}

function setSelectedDateRange(start, end, delay = 75) {
  if (!setTimelineDomain(start, end)) return;
  setDateRange(timelineDomainStart, timelineDomainEnd, delay);
}

function updateTimelineDomainFromInputs() {
  const start = parseInputTime(el.start.value);
  const end = parseInputTime(el.end.value);
  return setTimelineDomain(start, end);
}

function timelineMaxStep(stepMs = blockStepMs()) {
  if (!timelineDomainStart || !timelineDomainEnd) return 0;
  const span = timelineDomainEnd.getTime() - timelineDomainStart.getTime();
  return Math.max(0, Math.ceil(span / stepMs) - 1);
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
  const end = parseInputTime(el.end.value);
  const stepMs = blockStepMs();
  const maxStep = timelineMaxStep(stepMs);
  const stepIndex = Math.min(timelineStepForEnd(end, stepMs), maxStep);
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
  if (!range) return;
  setDateRange(range.start, range.end, delay);
}

function playbackDelayMs() {
  return Math.max(31, 1000 / Math.max(1, Number(el.timelineSpeed.value) || 1));
}

function playbackStepCount() {
  const maxStep = Number(el.timeline.max);
  const width = el.timeline.getBoundingClientRect().width;
  if (!Number.isFinite(maxStep) || maxStep <= 0 || !Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.ceil(maxStep / width));
}

function timelineBrushLoop() {
  if (!timelineBrushing) return;
  if (el.timeline.value !== lastTimelineValue) {
    lastTimelineValue = el.timeline.value;
    setRangeFromTimeline(0);
  }
  timelineBrushTimer = setTimeout(timelineBrushLoop, 16);
}

function startTimelineBrush() {
  if (timelineBrushing) return;
  setPlaying(false);
  timelineBrushing = true;
  lastTimelineValue = "";
  timelineBrushLoop();
}

function stopTimelineBrush() {
  timelineBrushing = false;
  if (timelineBrushTimer) {
    clearTimeout(timelineBrushTimer);
    timelineBrushTimer = undefined;
  }
}

function advanceTimelineStep() {
  const next = Number(el.timeline.value) + playbackStepCount();
  if (next > Number(el.timeline.max)) {
    setPlaying(false);
    return false;
  }
  el.timeline.value = String(next);
  setRangeFromTimeline(0);
  return true;
}

function playLoop() {
  if (!playTimer) return;
  if (!advanceTimelineStep()) return;
  playTimer = setTimeout(playLoop, playbackDelayMs());
}

function setPlaying(playing) {
  if (playTimer) {
    clearTimeout(playTimer);
    playTimer = undefined;
  }
  el.timelinePlay.setAttribute("aria-pressed", String(playing));
  el.timelinePlay.setAttribute("aria-label", playing ? "Pause timeline" : "Play timeline");
  el.timelinePlay.title = playing ? "Pause timeline" : "Play timeline";
  el.timelinePlayIcon.textContent = playing ? "Ⅱ" : "▶";
  if (!playing) return;
  if (Number(el.timeline.value) >= Number(el.timeline.max)) {
    el.timeline.value = "0";
    setRangeFromTimeline(0);
  }
  if (!advanceTimelineStep()) return;
  playTimer = setTimeout(playLoop, playbackDelayMs());
}

function applyDatePreset(preset) {
  if (!availableEnd) return;
  const end = new Date(availableEnd);
  const currentHourStart = hourStart(new Date(end.getTime() - 1));
  let start;
  let stop = end;
  if (preset === "current-hour") {
    start = currentHourStart;
    if (start >= end) start = new Date(end.getTime() - 60 * 60 * 1000);
  } else if (preset === "last-hour") {
    stop = currentHourStart;
    start = new Date(stop.getTime() - 60 * 60 * 1000);
  } else if (preset === "last-4-hours") {
    stop = currentHourStart;
    start = new Date(stop.getTime() - 4 * 60 * 60 * 1000);
  } else {
    return;
  }
  setSelectedDateRange(start, stop);
  el.datePanel.hidden = true;
}

function clampedRange() {
  let start = parseInputTime(el.start.value);
  let end = parseInputTime(el.end.value);
  if (availableStart && start < availableStart) start = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  if (availableStart && end <= availableStart) end = availableEnd;
  if (start >= end) start = availableStart;
  el.start.value = inputTime(start);
  el.end.value = inputTime(end);
  syncTimelineFromDates();
  return { start: inputTime(start), end: inputTime(end) };
}

function daySlices(startValue, endValue) {
  let end = parseInputTime(endValue);
  let cursor = parseInputTime(startValue);
  if (availableStart && cursor < availableStart) cursor = availableStart;
  if (availableEnd && end > availableEnd) end = availableEnd;
  const slices = [];
  while (cursor < end) {
    const nextDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1));
    const next = nextDay < end ? nextDay : end;
    slices.push({ label: cursor.toISOString().slice(0, 10), start: inputTime(cursor), end: inputTime(next) });
    cursor = next;
  }
  return slices;
}

function optionList() {
  return rubricOptions;
}

function setAxisFields() {
  const currentX = el.xField.value;
  const currentY = el.yField.value;
  const currentColor = el.colorField.value;
  const currentSize = el.sizeField.value;
  const options = optionList();
  el.xField.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  el.yField.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  el.colorField.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  el.sizeField.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  el.xField.value = options.some(([value]) => value === currentX) ? currentX : "mid";
  el.yField.value = options.some(([value]) => value === currentY) ? currentY : "ret_pct";
  el.colorField.value = options.some(([value]) => value === currentColor) ? currentColor : "ofi";
  el.sizeField.value = options.some(([value]) => value === currentSize) ? currentSize : "turnover";
  setBarControls();
}

function setBarControls() {
  el.barType.disabled = true;
  el.barFunction.disabled = true;
}

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const box = el.chart.getBoundingClientRect();
  el.chart.width = Math.max(1, Math.floor(box.width * ratio));
  el.chart.height = Math.max(1, Math.floor(box.height * ratio));
  draw();
}

function fmt(value) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.000001) return trimFixed(value, 10);
  if (abs < 0.001) return trimFixed(value, 8);
  if (abs < 1) return trimFixed(value, 6);
  return value.toLocaleString(undefined, { maximumFractionDigits: abs >= 100_000 ? 2 : 6 });
}

function trimFixed(value, digits) {
  const text = value.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
  return text === "-0" ? "0" : text;
}

function fmtCompact(value) {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${trimFixed(value / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${trimFixed(value / 1_000, 2)}K`;
  return fmt(value);
}

function blockLabel(seconds) {
  if (seconds < 1) return `${trimFixed(seconds * 1000, 3)}ms`;
  return `${seconds}s`;
}

function fieldLabel(field) {
  return fieldLabels[field] || field;
}

function axisLabel(field, scale) {
  const label = fieldLabel(field);
  return scale === "linear" ? label : `${label} (${scale})`;
}

function controlScale(id) {
  return el[id].checked ? "log" : "linear";
}

function outlierEnabled(channel) {
  return el[`${channel}Outlier`].checked;
}

function activeOutlierChannels() {
  return channels.filter((channel) => outlierEnabled(channel));
}

function domain(min, max) {
  if (min === max) return { min: min - 0.5, max: max + 0.5 };
  return { min, max };
}

function fieldDomain(field, rawDomain) {
  if (unitFields.has(field)) return { min: 0, max: 1, hard: true };
  return rawDomain;
}

function zStats(values) {
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  let squared = 0;
  for (const value of values) squared += (value - mean) ** 2;
  const std = Math.sqrt(squared / values.length);
  return { mean, std };
}

function zKeep(value, stats) {
  if (!stats || stats.std === 0) return true;
  return Math.abs((value - stats.mean) / stats.std) <= Z_SCORE_LIMIT;
}

function filteredScatterData(data) {
  if (data.outlierFiltered) return data;
  const active = activeOutlierChannels();
  if (active.length === 0) return data;
  const stats = Object.fromEntries(active.map((channel) => [channel, zStats(data[channel])]));
  const x = [];
  const y = [];
  const color = [];
  const size = [];
  for (let index = 0; index < data.x.length; index += 1) {
    let keep = true;
    for (const channel of active) {
      if (!zKeep(data[channel][index], stats[channel])) {
        keep = false;
        break;
      }
    }
    if (!keep) continue;
    x.push(data.x[index]);
    y.push(data.y[index]);
    color.push(data.color[index]);
    size.push(data.size[index]);
  }
  if (x.length === 0) return { ...data, x, y, color, size, shown: 0, outlierFiltered: true };
  return {
    ...data,
    x,
    y,
    color,
    size,
    x_min: Math.min(...x),
    x_max: Math.max(...x),
    y_min: Math.min(...y),
    y_max: Math.max(...y),
    color_min: Math.min(...color),
    color_max: Math.max(...color),
    size_min: Math.min(...size),
    size_max: Math.max(...size),
    shown: x.length,
    outlierFiltered: true,
  };
}

function scaleType(scale) {
  return typeof scale === "string" ? scale : scale.type;
}

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
  if (type === "power") return Math.sign(value) * Math.sqrt(Math.abs(value));
  return value;
}

function inverseScaleValue(value, scale) {
  const type = scaleType(scale);
  if (type === "log-positive") return 10 ** value;
  if (type === "log-negative") return -(10 ** -value);
  if (type === "symlog") return Math.sign(value) * scale.constant * (10 ** Math.abs(value) - 1);
  if (type === "power") return Math.sign(value) * value * value;
  return value;
}

function cleanValue(value) {
  const cleaned = Number(value.toPrecision(12));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}

function scaledDomain(rawDomain, scale) {
  return domain(scaleValue(rawDomain.min, scale), scaleValue(rawDomain.max, scale));
}

function scaledPosition(value, scaled, scale) {
  const width = scaled.max - scaled.min;
  if (width === 0) return 0.5;
  return (scaleValue(value, scale) - scaled.min) / width;
}

function niceStep(span, targetIntervals) {
  const raw = span / Math.max(1, targetIntervals);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const choices = [1, 2, 2.5, 5, 10].map((item) => item * magnitude);
  return choices.reduce((best, item) => {
    const bestDistance = Math.abs(Math.log(best / raw));
    const itemDistance = Math.abs(Math.log(item / raw));
    return itemDistance < bestDistance ? item : best;
  }, choices[0]);
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
  const cleaned = Number(value.toFixed(digits));
  return Object.is(cleaned, -0) ? 0 : cleaned;
}

function niceTicks(min, max, target) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min > max) return niceTicks(max, min, target);
  if (min === max) return [min];
  const span = max - min;
  let step = niceStep(span, Math.max(2, target - 1));
  let ticks = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    ticks = [];
    const start = Math.ceil(min / step) * step;
    const stop = Math.floor(max / step) * step;
    for (let value = start; value <= stop + step * 0.5; value += step) {
      ticks.push(cleanTick(value, step));
    }
    if (ticks.length <= target + 3) break;
    step = nextNiceStep(step);
  }
  if (min < 0 && max > 0 && !ticks.includes(0)) ticks.push(0);
  ticks.sort((a, b) => a - b);
  return ticks.length > 1 ? ticks : [min, max];
}

function fixedAxis(rawDomain, count) {
  if (rawDomain.min < 0 && rawDomain.max > 0 && count % 2 === 1) {
    const half = (count - 1) / 2;
    let step = niceStep(Math.max(Math.abs(rawDomain.min), Math.abs(rawDomain.max)) / half, 1);
    while (step * half < Math.max(Math.abs(rawDomain.min), Math.abs(rawDomain.max))) step = nextNiceStep(step);
    return Array.from({ length: count }, (_, index) => cleanTick((index - half) * step, step));
  }
  let step = niceStep((rawDomain.max - rawDomain.min) / Math.max(1, count - 1), 1);
  let start = Math.floor(rawDomain.min / step) * step;
  let end = start + step * (count - 1);
  while (end < rawDomain.max) {
    step = nextNiceStep(step);
    start = Math.floor(rawDomain.min / step) * step;
    end = start + step * (count - 1);
  }
  return Array.from({ length: count }, (_, index) => cleanTick(start + index * step, step));
}

function boundedTicks(rawDomain, count) {
  let step = niceStep((rawDomain.max - rawDomain.min) / Math.max(1, count - 1), 1);
  let ticks = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    ticks = [];
    const start = Math.ceil(rawDomain.min / step) * step;
    const stop = Math.floor(rawDomain.max / step) * step;
    for (let value = start; value <= stop + step * 0.5; value += step) {
      ticks.push(cleanTick(value, step));
    }
    if (ticks.length <= count + 2) break;
    step = nextNiceStep(step);
  }
  if (!ticks.includes(rawDomain.min)) ticks.unshift(rawDomain.min);
  if (!ticks.includes(rawDomain.max)) ticks.push(rawDomain.max);
  return Array.from(new Set(ticks)).sort((a, b) => a - b);
}

function axisSpec(rawDomain, scale, count) {
  if (rawDomain.hard && scaleType(scale) === "linear") return { domain: rawDomain, ticks: boundedTicks(rawDomain, count) };
  if (scaleType(scale) !== "linear") {
    const scaled = scaledDomain(rawDomain, scale);
    const ticks = boundedTicks(scaled, count).map((value) => cleanValue(inverseScaleValue(value, scale)));
    return { domain: rawDomain, ticks };
  }
  const ticks = fixedAxis(rawDomain, count);
  return { domain: domain(ticks[0], ticks[ticks.length - 1]), ticks };
}

function midTickValue(left, right, scale) {
  return inverseScaleValue((scaleValue(left, scale) + scaleValue(right, scale)) / 2, scale);
}

function hexRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Canvas colors read from the :root palette literals so the chart and the CSS
// chrome are one theme (Mill's "JS reads CSS" rule). Palette custom properties
// hold plain hex, so getComputedStyle returns them verbatim.
function theme() {
  if (THEME) return THEME;
  const css = getComputedStyle(document.documentElement);
  const value = (name) => css.getPropertyValue(name).trim();
  THEME = {
    bg: value("--c-near-black"),
    fg2: value("--c-light-gray"),
    gridMajor: value("--c-dark-gray"),
    gridMinor: value("--c-warm-black"),
    tick: value("--c-mid-gray"),
    rampLo: hexRgb(value("--c-lavender")),
    rampHi: hexRgb(value("--c-coral")),
  };
  return THEME;
}

function draw() {
  const width = el.chart.width;
  const height = el.chart.height;
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, width, height);
  if (!latest) return;
  if (latest.kind === "grid") {
    drawGrid(width, height);
    return;
  }
  drawScatter(latest, { x: 0, y: 0, width, height, title: "" }, null);
}

function drawScatter(data, box, scale) {
  data = filteredScatterData(data);
  const ratio = window.devicePixelRatio || 1;
  const inGrid = Boolean(box.title);
  const showXLabels = box.showXLabels !== false;
  const showYLabels = box.showYLabels !== false;
  const pad = inGrid
    ? { left: (showYLabels ? 42 : 6) * ratio, right: 8 * ratio, top: 24 * ratio, bottom: (showXLabels ? 24 : 6) * ratio }
    : { left: 70 * ratio, right: 24 * ratio, top: 42 * ratio, bottom: 52 * ratio };
  const xScale = controlScale("xScale");
  const yScale = controlScale("yScale");
  const colorScale = controlScale("colorScale");
  const sizeScale = controlScale("sizeScale");
  if (data.shown === 0) {
    ctx.fillStyle = theme().fg2;
    ctx.font = `${12 * ratio}px ${FONT_SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No points after z-score filter", box.x + box.width / 2, box.y + box.height / 2);
    return;
  }
  const xRawDomain = fieldDomain(el.xField.value, scale ? scale.x : domain(data.x_min, data.x_max));
  const yRawDomain = fieldDomain(el.yField.value, scale ? scale.y : domain(data.y_min, data.y_max));
  const colorRawDomain = fieldDomain(el.colorField.value, scale ? scale.color : domain(data.color_min, data.color_max));
  const sizeRawDomain = fieldDomain(el.sizeField.value, scale ? scale.size : domain(data.size_min, data.size_max));
  const xScaleConfig = scaleConfig(xScale, xRawDomain);
  const yScaleConfig = scaleConfig(yScale, yRawDomain);
  const colorScaleConfig = scaleConfig(colorScale, colorRawDomain);
  const sizeScaleConfig = scaleConfig(sizeScale, sizeRawDomain);
  const compact = inGrid || box.width < 320 * ratio;
  const tickCount = compact ? 5 : 9;
  const xAxis = axisSpec(xRawDomain, xScaleConfig, tickCount);
  const yAxis = axisSpec(yRawDomain, yScaleConfig, tickCount);
  const xDomain = scaledDomain(xAxis.domain, xScaleConfig);
  const yDomain = scaledDomain(yAxis.domain, yScaleConfig);
  const colorDomain = scaledDomain(colorRawDomain, colorScaleConfig);
  const sizeDomain = scaledDomain(sizeRawDomain, sizeScaleConfig);
  const innerW = Math.max(1, box.width - pad.left - pad.right);
  const innerH = Math.max(1, box.height - pad.top - pad.bottom);
  const left = box.x + pad.left;
  const top = box.y + pad.top;
  const bottom = top + innerH;
  drawGridTicks(left, top, innerW, innerH, xAxis.ticks, yAxis.ticks, xDomain, yDomain, xScaleConfig, yScaleConfig, ratio, compact, showXLabels, showYLabels);
  drawZeroAxes(left, top, innerW, innerH, xAxis.domain, yAxis.domain, xDomain, yDomain, xScaleConfig, yScaleConfig, ratio, showXLabels, showYLabels);
  const xWidth = xDomain.max - xDomain.min;
  const yWidth = yDomain.max - yDomain.min;
  const colorWidth = colorDomain.max - colorDomain.min;
  const sizeWidth = sizeDomain.max - sizeDomain.min;
  for (let i = 0; i < data.x.length; i += 1) {
    const x = left + (scaleValue(data.x[i], xScaleConfig) - xDomain.min) / xWidth * innerW;
    const y = bottom - (scaleValue(data.y[i], yScaleConfig) - yDomain.min) / yWidth * innerH;
    const colorT = clamp01((scaleValue(data.color[i], colorScaleConfig) - colorDomain.min) / colorWidth);
    const sizeT = clamp01((scaleValue(data.size[i], sizeScaleConfig) - sizeDomain.min) / sizeWidth);
    const radius = (1 + 4 * Math.sqrt(sizeT)) * ratio;
    ctx.fillStyle = colorFor(colorT);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = theme().fg2;
  ctx.font = `${(compact ? 11 : 12) * ratio}px ${FONT_SANS}`;
  if (box.title) {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(box.title, box.x + box.width / 2, box.y + 3 * ratio);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
  if (!inGrid) {
    ctx.fillStyle = theme().fg2;
    ctx.font = `${12 * ratio}px ${FONT_SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(axisLabel(el.xField.value, xScale), left + innerW / 2, box.y + box.height - 8 * ratio);
    ctx.save();
    ctx.translate(box.x + 18 * ratio, top + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(axisLabel(el.yField.value, yScale), 0, 0);
    ctx.restore();
  }
}

function shouldLabelTick(ticks, index, compact) {
  if (!compact) return true;
  if (ticks.length <= 5) return true;
  const value = ticks[index];
  if (value === 0 || index === 0 || index === ticks.length - 1) return true;
  return index % Math.max(2, Math.ceil(ticks.length / 4)) === 0;
}

function drawGridTicks(left, top, innerW, innerH, xTicks, yTicks, xDomain, yDomain, xScale, yScale, ratio, compact, showXLabels, showYLabels) {
  const right = left + innerW;
  const bottom = top + innerH;
  const label = compact ? fmtCompact : fmt;
  ctx.save();
  ctx.strokeStyle = theme().gridMajor;
  ctx.lineWidth = ratio;
  ctx.beginPath();
  for (const value of xTicks) {
    const x = left + scaledPosition(value, xDomain, xScale) * innerW;
    if (x < left - 1 || x > right + 1) continue;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (const value of yTicks) {
    const y = bottom - scaledPosition(value, yDomain, yScale) * innerH;
    if (y < top - 1 || y > bottom + 1) continue;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
  ctx.strokeStyle = theme().gridMinor;
  ctx.beginPath();
  for (let index = 0; index < xTicks.length - 1; index += 1) {
    const value = midTickValue(xTicks[index], xTicks[index + 1], xScale);
    const x = left + scaledPosition(value, xDomain, xScale) * innerW;
    if (x < left - 1 || x > right + 1) continue;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let index = 0; index < yTicks.length - 1; index += 1) {
    const value = midTickValue(yTicks[index], yTicks[index + 1], yScale);
    const y = bottom - scaledPosition(value, yDomain, yScale) * innerH;
    if (y < top - 1 || y > bottom + 1) continue;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
  ctx.strokeStyle = theme().tick;
  ctx.beginPath();
  for (const value of xTicks) {
    const x = left + scaledPosition(value, xDomain, xScale) * innerW;
    if (x < left - 1 || x > right + 1) continue;
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom + 5 * ratio);
  }
  for (const value of yTicks) {
    const y = bottom - scaledPosition(value, yDomain, yScale) * innerH;
    if (y < top - 1 || y > bottom + 1) continue;
    ctx.moveTo(left - 5 * ratio, y);
    ctx.lineTo(left, y);
  }
  ctx.stroke();
  ctx.fillStyle = theme().fg2;
  ctx.font = `${(compact ? 9 : 11) * ratio}px ${FONT_MONO}`;
  ctx.textBaseline = "top";
  if (showXLabels) {
    let lastXLabel = -Infinity;
    xTicks.forEach((value, index) => {
      if (!shouldLabelTick(xTicks, index, compact)) return;
      const x = left + scaledPosition(value, xDomain, xScale) * innerW;
      if (x < left - 1 || x > right + 1) return;
      if (xTicks.length > 5 && value !== 0 && x - lastXLabel < (compact ? 40 : 58) * ratio) return;
      ctx.textAlign = index === 0 ? "left" : index === xTicks.length - 1 ? "right" : "center";
      ctx.fillText(label(value), x, bottom + 8 * ratio);
      lastXLabel = x;
    });
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  if (showYLabels) {
    const yLabelPositions = [];
    yTicks.forEach((value, index) => {
      if (!shouldLabelTick(yTicks, index, compact)) return;
      const y = bottom - scaledPosition(value, yDomain, yScale) * innerH;
      if (y < top - 1 || y > bottom + 1) return;
      if (yTicks.length > 5 && value !== 0 && yLabelPositions.some((position) => Math.abs(position - y) < (compact ? 16 : 18) * ratio)) return;
      ctx.fillText(label(value), left - 8 * ratio, y);
      yLabelPositions.push(y);
    });
  }
  ctx.restore();
}

function drawZeroAxes(left, top, innerW, innerH, xRawDomain, yRawDomain, xDomain, yDomain, xScale, yScale, ratio, showXLabels, showYLabels) {
  const right = left + innerW;
  const bottom = top + innerH;
  ctx.save();
  ctx.strokeStyle = theme().tick;
  ctx.lineWidth = 1.5 * ratio;
  ctx.setLineDash([5 * ratio, 4 * ratio]);
  if (xRawDomain.min <= 0 && xRawDomain.max >= 0) {
    const zeroX = left + scaledPosition(0, xDomain, xScale) * innerW;
    ctx.beginPath();
    ctx.moveTo(zeroX, top);
    ctx.lineTo(zeroX, bottom);
    ctx.stroke();
  }
  if (yRawDomain.min <= 0 && yRawDomain.max >= 0) {
    const zeroY = bottom - scaledPosition(0, yDomain, yScale) * innerH;
    ctx.beginPath();
    ctx.moveTo(left, zeroY);
    ctx.lineTo(right, zeroY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGrid(width, height) {
  const cells = latest.cells.map((cell) => filteredScatterData(cell)).filter((cell) => cell.shown > 0);
  if (cells.length === 0) {
    const ratio = window.devicePixelRatio || 1;
    ctx.fillStyle = theme().fg2;
    ctx.font = `${12 * ratio}px ${FONT_SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No grid cells after z-score filter", width / 2, height / 2);
    return;
  }
  const scale = gridScale(cells);
  const ratio = window.devicePixelRatio || 1;
  const { columns, rows } = gridLayout(width, height, cells.length, ratio);
  const gap = 5 * ratio;
  const cellW = (width - gap * (columns + 1)) / columns;
  const cellH = (height - gap * (rows + 1)) / rows;
  cells.forEach((cell, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    const lastRow = row === rows - 1;
    drawScatter(cell, {
      x: gap + column * (cellW + gap),
      y: gap + row * (cellH + gap),
      width: cellW,
      height: cellH,
      title: cell.label,
      showXLabels: lastRow,
      showYLabels: column === 0,
    }, scale);
  });
}

function gridLayout(width, height, count, ratio) {
  const gap = 5 * ratio;
  let best = { columns: Math.ceil(Math.sqrt(count)), rows: Math.ceil(Math.sqrt(count)), score: -Infinity };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellW = (width - gap * (columns + 1)) / columns;
    const cellH = (height - gap * (rows + 1)) / rows;
    const innerW = cellW - 50 * ratio;
    const innerH = cellH - 48 * ratio;
    if (innerW <= 40 * ratio || innerH <= 36 * ratio) continue;
    const aspectPenalty = Math.abs(Math.log((innerW / innerH) / 1.35)) * innerW * innerH * 0.08;
    const emptyPenalty = (columns * rows - count) * innerW * innerH * 0.12;
    const score = innerW * innerH - aspectPenalty - emptyPenalty;
    if (score > best.score) best = { columns, rows, score };
  }
  return best;
}

function gridScale(cells) {
  return {
    x: domain(Math.min(...cells.map((cell) => cell.x_min)), Math.max(...cells.map((cell) => cell.x_max))),
    y: domain(Math.min(...cells.map((cell) => cell.y_min)), Math.max(...cells.map((cell) => cell.y_max))),
    color: domain(Math.min(...cells.map((cell) => cell.color_min)), Math.max(...cells.map((cell) => cell.color_max))),
    size: domain(Math.min(...cells.map((cell) => cell.size_min)), Math.max(...cells.map((cell) => cell.size_max))),
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function colorFor(t) {
  const { rampLo, rampHi } = theme();
  const u = clamp01(t);
  const r = Math.round(rampLo[0] + (rampHi[0] - rampLo[0]) * u);
  const g = Math.round(rampLo[1] + (rampHi[1] - rampLo[1]) * u);
  const b = Math.round(rampLo[2] + (rampHi[2] - rampLo[2]) * u);
  return `rgba(${r}, ${g}, ${b}, 0.55)`;
}

async function run() {
  if (activeRequest) activeRequest.abort();
  const range = clampedRange();
  const request = new AbortController();
  activeRequest = request;
  el.status.value = "Loading";
  const started = performance.now();
  try {
    let data;
    if (el.grid.value === "day") {
      data = await runDayGrid(range, request);
    } else if (el.grid.value === "groupby") {
      data = await runGroupbyGrid(range, request);
    } else {
      data = await fetchScatter(scatterQs(range.start, range.end), request);
    }
    if (activeRequest !== request) return;
    latest = data;
    el.status.value = statusText(latest);
    el.status.classList.toggle("grid-status", latest.kind === "grid");
    draw();
  } catch (error) {
    if (activeRequest === request && error.name !== "AbortError") {
      el.status.value = error.message;
      console.error(error);
    }
  } finally {
    if (activeRequest === request) activeRequest = undefined;
    console.debug(`scatter ${(performance.now() - started).toFixed(1)} ms`);
  }
}

async function fetchScatter(query, request) {
  const response = await fetch(`api/scatter?${query}`, { signal: request.signal });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function fetchGridFields(range, fields, request) {
  const params = new URLSearchParams({
    start_datetime: range.start,
    end_datetime: range.end,
    bar_interval: el.barInterval.value,
    fraction: el.fraction.value,
    fields: fields.join(","),
  });
  const response = await fetch(`api/grid_fields?${params.toString()}`, request ? { signal: request.signal } : undefined);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function fetchGroupbyFields(range, fields, request) {
  const params = new URLSearchParams({
    start_datetime: range.start,
    end_datetime: range.end,
    fraction: el.fraction.value,
    fields: fields.join(","),
  });
  const response = await fetch(`api/groupby_fields?${params.toString()}`, request ? { signal: request.signal } : undefined);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function mergeGridFields(cache, payload) {
  cache.elapsed_ms = Math.max(cache.elapsed_ms, payload.elapsed_ms);
  payload.cells.forEach((cellPayload) => {
    let cell = cache.cells.get(cellPayload.label);
    if (!cell) {
      cell = { label: cellPayload.label, rows: cellPayload.rows, shown: cellPayload.shown, fields: new Map() };
      cache.cells.set(cellPayload.label, cell);
    }
    cell.rows = cellPayload.rows;
    cell.shown = cellPayload.shown;
    Object.entries(cellPayload.fields).forEach(([field, values]) => {
      cell.fields.set(field, values);
      cache.fields.add(field);
    });
  });
}

async function runDayGrid(range, request) {
  const cacheKey = `${range.start}|${range.end}|${el.barInterval.value}|${el.fraction.value}`;
  let cache = gridFieldCache.get(cacheKey);
  if (!cache) {
    cache = { cells: new Map(), fields: new Set(), elapsed_ms: 0 };
    gridFieldCache.set(cacheKey, cache);
  }
  const needed = [el.xField.value, el.yField.value, el.colorField.value, el.sizeField.value];
  const missing = needed.filter((field, index) => needed.indexOf(field) === index && !cache.fields.has(field));
  if (missing.length > 0) {
    const payload = await fetchGridFields(range, missing, request);
    mergeGridFields(cache, payload);
  }
  const grid = assembleGrid(cache, needed);
  warmGridCache(range, cache);
  return grid;
}

async function runGroupbyGrid(range, request) {
  const cacheKey = `${range.start}|${range.end}|${el.fraction.value}`;
  let cache = groupbyFieldCache.get(cacheKey);
  if (!cache) {
    cache = { cells: new Map(), fields: new Set(), elapsed_ms: 0 };
    groupbyFieldCache.set(cacheKey, cache);
  }
  const needed = [el.xField.value, el.yField.value, el.colorField.value, el.sizeField.value];
  const missing = needed.filter((field, index) => needed.indexOf(field) === index && !cache.fields.has(field));
  if (missing.length > 0) {
    const payload = await fetchGroupbyFields(range, missing, request);
    mergeGridFields(cache, payload);
  }
  return assembleGrid(cache, needed, "groupby");
}

function cacheShown(cache) {
  return Array.from(cache.cells.values()).reduce((sum, cell) => sum + cell.shown, 0);
}

function warmGridCache(range, cache) {
  if (cache.warming || cacheShown(cache) > 300_000) return;
  const missing = rubricOptions.map(([field]) => field).filter((field) => !cache.fields.has(field));
  if (missing.length === 0) return;
  cache.warming = true;
  setTimeout(async () => {
    try {
      for (let index = 0; index < missing.length; index += 4) {
        const fields = missing.slice(index, index + 4).filter((field) => !cache.fields.has(field));
        if (fields.length === 0) continue;
        mergeGridFields(cache, await fetchGridFields(range, fields));
      }
    } finally {
      cache.warming = false;
    }
  }, 0);
}

function assembleGrid(cache, fields, gridBy = "day") {
  const sourceCells = Array.from(cache.cells.values());
  if (gridBy === "day") sourceCells.sort((a, b) => a.label.localeCompare(b.label));
  const cells = sourceCells.map((cell) => {
    const xRaw = cell.fields.get(fields[0]);
    const yRaw = cell.fields.get(fields[1]);
    const colorRaw = cell.fields.get(fields[2]);
    const sizeRaw = cell.fields.get(fields[3]);
    const x = [];
    const y = [];
    const color = [];
    const size = [];
    for (let index = 0; index < xRaw.length; index += 1) {
      const xValue = Number(xRaw[index]);
      const yValue = Number(yRaw[index]);
      const colorValue = Number(colorRaw[index]);
      const sizeValue = Number(sizeRaw[index]);
      if (!Number.isFinite(xValue) || !Number.isFinite(yValue) || !Number.isFinite(colorValue) || !Number.isFinite(sizeValue)) continue;
      x.push(xValue);
      y.push(yValue);
      color.push(colorValue);
      size.push(sizeValue);
    }
    if (x.length === 0) return null;
    return {
      label: cell.label,
      x,
      y,
      color,
      size,
      x_min: Math.min(...x),
      x_max: Math.max(...x),
      y_min: Math.min(...y),
      y_max: Math.max(...y),
      color_min: Math.min(...color),
      color_max: Math.max(...color),
      size_min: Math.min(...size),
      size_max: Math.max(...size),
      rows: cell.rows,
      points: x.length,
      shown: x.length,
      elapsed_ms: cache.elapsed_ms,
    };
  }).filter(Boolean);
  if (cells.length === 0) throw new Error("No finite grid rows match the current slice");
  return { kind: "grid", gridBy, cells };
}

function statusText(data) {
  const active = activeOutlierChannels();
  const zText = active.length > 0 ? ` | z ${active.join(",")}` : "";
  if (data.kind === "grid") {
    const cells = active.length > 0 ? data.cells.map((cell) => filteredScatterData(cell)).filter((cell) => cell.shown > 0) : data.cells;
    if (cells.length === 0) return `grid ${data.gridBy}${zText} | cells 0 | rows 0 | points 0 | shown 0\nno cells after z-score filter`;
    const rows = cells.reduce((sum, cell) => sum + cell.rows, 0);
    const points = cells.reduce((sum, cell) => sum + cell.points, 0);
    const shown = cells.reduce((sum, cell) => sum + cell.shown, 0);
    const elapsed = Math.max(...cells.map((cell) => cell.elapsed_ms));
    const block = data.gridBy === "day" ? ` | block ${blockLabel(Number(el.barInterval.value))}` : "";
    return `grid ${data.gridBy}${block}${zText} | cells ${cells.length} | rows ${rows.toLocaleString()} | points ${points.toLocaleString()} | shown ${shown.toLocaleString()}\nmax server ${elapsed} ms`;
  }
  const display = filteredScatterData(data);
  if (display.shown === 0) {
    return `block ${blockLabel(data.block_seconds)}${zText} | rows ${data.rows.toLocaleString()} | points ${data.points.toLocaleString()} | shown 0\nno points after z-score filter | ${data.elapsed_ms} ms server`;
  }
  return `block ${blockLabel(data.block_seconds)}${zText} | rows ${data.rows.toLocaleString()} | points ${data.points.toLocaleString()} | shown ${display.shown.toLocaleString()}\n${el.xField.value} ${fmt(display.x_min)}..${fmt(display.x_max)} | ${el.yField.value} ${fmt(display.y_min)}..${fmt(display.y_max)} | ${data.elapsed_ms} ms server`;
}

function schedule(delay = 75) {
  clearTimeout(debounce);
  debounce = setTimeout(run, delay);
}

el.tooltip.hidden = true;
el.dateToggle.addEventListener("click", () => { el.datePanel.hidden = !el.datePanel.hidden; });
el.datePresetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyDatePreset(button.dataset.datePreset);
  });
});
dataIds.forEach((id) => {
  const handler = () => {
    if (id === "barType") setAxisFields();
    if (id === "start" || id === "end") {
      setPlaying(false);
      updateTimelineDomainFromInputs();
    }
    if (id === "start" || id === "end" || id === "barInterval") syncTimelineFromDates();
    schedule();
  };
  el[id].addEventListener("input", handler);
  el[id].addEventListener("change", handler);
});
el.timeline.addEventListener("pointerdown", startTimelineBrush);
el.timeline.addEventListener("pointerup", stopTimelineBrush);
el.timeline.addEventListener("pointercancel", stopTimelineBrush);
el.timeline.addEventListener("input", () => { setRangeFromTimeline(0); });
el.timeline.addEventListener("change", () => { setRangeFromTimeline(0); });
el.timelinePlay.addEventListener("click", () => {
  setPlaying(!playTimer);
});
el.timelineSpeed.addEventListener("change", () => {
  if (playTimer) setPlaying(true);
});
scaleIds.forEach((id) => {
  el[id].addEventListener("input", draw);
  el[id].addEventListener("change", draw);
});
outlierIds.forEach((id) => {
  const handler = () => {
    if (latest) el.status.value = statusText(latest);
    draw();
  };
  el[id].addEventListener("input", handler);
  el[id].addEventListener("change", handler);
});
window.addEventListener("resize", resize);

fetch("api/meta")
  .then((response) => response.json())
  .then((meta) => {
    availableStart = parseInputTime(meta.start);
    availableEnd = parseInputTime(meta.end);
    const defaultStart = new Date(Math.max(availableStart.getTime(), availableEnd.getTime() - 4 * 60 * 60 * 1000));
    setTimelineDomain(defaultStart, availableEnd);
    el.start.value = inputTime(timelineDomainStart);
    el.end.value = inputTime(timelineDomainEnd);
    el.barType.value = "time";
    el.barInterval.value = "0.125";
    el.barFunction.value = "rubric";
    el.xField.value = "mid";
    el.yField.value = "ret_pct";
    el.colorField.value = "ofi";
    el.sizeField.value = "turnover";
    scaleIds.forEach((id) => { el[id].checked = false; });
    outlierIds.forEach((id) => { el[id].checked = false; });
    setAxisFields();
    syncTimelineFromDates();
    resize();
    run();
  });
