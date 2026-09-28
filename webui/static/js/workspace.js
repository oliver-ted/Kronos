/* Ascentia Forecast Workspace client */
(function () {
    'use strict';

    const COLORS = {
        text: '#d6dbe3',
        muted: '#8b95a5',
        faint: '#5d6778',
        border: '#1f2631',
        borderStrong: '#2b3441',
        grid: '#1a2029',
        raised: '#151a23',
        panel: '#10141b',
        up: '#3fae88',
        down: '#de5b52',
        accent: '#e3a63b',
        accentBand: 'rgba(227, 166, 59, 0.16)',
        accentRegion: 'rgba(227, 166, 59, 0.035)',
        context: '#5b8fd6',
        volHist: '#2c3542',
        volActual: '#252c37',
    };
    const MONO = 'JetBrains Mono, IBM Plex Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace';
    const SAMPLING_DEFAULTS = { temperature: 1.0, topP: 0.9, samples: 1 };
    const LOG_LIMIT = 200;

    const $ = (id) => document.getElementById(id);

    const state = {
        libraryAvailable: false,
        models: {},
        devices: [],
        dataDirs: [],
        model: null,          // loaded model info from the server
        files: [],
        data: null,           // data_info of the loaded file plus file metadata
        lookback: 400,
        predLen: 120,
        start: 0,
        samples: SAMPLING_DEFAULTS.samples,
        result: null,
        forecastStyle: 'band',
        scale: 'linear',
        busy: { model: false, data: false, predict: false },
        traces: null,         // trace indices by role in the price chart
    };

    /* ---------------------------------------------------------------- utils */

    async function api(path, body) {
        const options = body === undefined
            ? { method: 'GET' }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        let response;
        try {
            response = await fetch(path, options);
        } catch (err) {
            throw new Error('Cannot reach the Ascentia server. Check that webui/app.py is still running.');
        }
        let payload = null;
        try {
            payload = await response.json();
        } catch (err) {
            payload = null;
        }
        if (!response.ok || (payload && payload.error)) {
            throw new Error((payload && payload.error) || `Request failed with HTTP ${response.status}`);
        }
        return payload;
    }

    function setText(id, text) {
        $(id).textContent = text;
    }

    function setBusy(button, busy, label) {
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (label) button.querySelector('.btn-label').textContent = label;
    }

    function priceDigits(value) {
        const v = Math.abs(value);
        if (v >= 1000) return 2;
        if (v >= 10) return 3;
        if (v >= 1) return 4;
        return 6;
    }

    function fmtNum(value, digits) {
        if (value === null || value === undefined || !Number.isFinite(value)) return '—';
        return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    function fmtPrice(value) {
        return fmtNum(value, state.data ? state.data.digits : 4);
    }

    function fmtSigned(value, digits) {
        if (!Number.isFinite(value)) return '—';
        return (value > 0 ? '+' : value < 0 ? '−' : '') + fmtNum(Math.abs(value), digits);
    }

    function fmtPct(value, digits = 2, signed = false) {
        if (!Number.isFinite(value)) return '—';
        return (signed ? fmtSigned(value * 100, digits) : fmtNum(value * 100, digits)) + '%';
    }

    function fmtCompact(value) {
        if (!Number.isFinite(value)) return '—';
        return value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
    }

    function fmtInt(value) {
        return value.toLocaleString('en-US');
    }

    // Timestamps from the server are naive (exchange-local) times; keep them as written.
    function timeResolution() {
        return state.data ? state.data.resolution : 'minute';
    }

    function fmtIso(iso) {
        if (!iso) return '—';
        const s = iso.replace('T', ' ');
        const res = timeResolution();
        if (res === 'day') return s.slice(0, 10);
        if (res === 'second') return s.slice(0, 19);
        return s.slice(0, 16);
    }

    function fmtEpoch(seconds) {
        return fmtIso(new Date(seconds * 1000).toISOString().slice(0, 19));
    }

    function fmtDuration(ms) {
        const s = Math.round(ms / 1000);
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    }

    function resolutionOf(timeframe) {
        if (/second/.test(timeframe)) return 'second';
        if (/day/.test(timeframe)) return 'day';
        return 'minute';
    }

    function nowClock() {
        return new Date().toLocaleTimeString('en-GB', { hour12: false });
    }

    /* ------------------------------------------------------------------ log */

    function log(level, message) {
        const list = $('log');
        const empty = list.querySelector('.log-empty');
        if (empty) empty.remove();

        const item = document.createElement('li');
        item.dataset.level = level;
        const time = document.createElement('time');
        time.textContent = nowClock();
        const lvl = document.createElement('span');
        lvl.className = 'lvl';
        lvl.textContent = { ok: 'ok', info: 'info', warn: 'warn', error: 'error' }[level] || level;
        const msg = document.createElement('span');
        msg.className = 'msg';
        msg.textContent = message;
        item.append(time, lvl, msg);
        list.prepend(item);

        while (list.children.length > LOG_LIMIT) list.lastElementChild.remove();
    }

    function clearLog() {
        const list = $('log');
        list.textContent = '';
        const empty = document.createElement('li');
        empty.className = 'log-empty';
        empty.textContent = 'No events.';
        list.append(empty);
    }

    function panelMessage(id, level, text) {
        const el = $(id);
        if (!text) {
            el.hidden = true;
            return;
        }
        el.hidden = false;
        el.dataset.level = level;
        el.textContent = text;
    }

    /* ---------------------------------------------------------------- model */

    async function fetchCatalogue() {
        try {
            const res = await api('/api/available-models');
            state.libraryAvailable = !!res.model_available;
            state.models = res.models || {};
            state.devices = res.devices || [{ id: 'cpu', label: 'CPU', available: true }];
            state.dataDirs = res.data_dirs || ['data'];
            populateModelControls();
            if (!state.libraryAvailable) {
                panelMessage('model-msg', 'error', 'The server could not import the Kronos model package. Install requirements.txt in the server environment and restart it.');
                log('error', 'Kronos model package unavailable on the server.');
            }
        } catch (err) {
            panelMessage('model-msg', 'error', err.message);
            log('error', `Model catalogue: ${err.message}`);
        }
    }

    function populateModelControls() {
        const select = $('model-select');
        select.textContent = '';
        Object.entries(state.models).forEach(([key, m]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = `${m.name} · ${m.params}`;
            select.append(opt);
        });
        if (state.models['kronos-small']) select.value = 'kronos-small';

        const devices = $('device-select');
        devices.textContent = '';
        state.devices.forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.available ? d.label : `${d.label} (not detected)`;
            opt.disabled = !d.available;
            devices.append(opt);
        });
        const preferred = state.devices.find((d) => d.available && d.id !== 'cpu');
        devices.value = preferred ? preferred.id : 'cpu';

        const enabled = state.libraryAvailable && Object.keys(state.models).length > 0;
        select.disabled = !enabled;
        devices.disabled = !enabled;
        renderModelMeta();
    }

    function renderModelMeta() {
        const m = state.models[$('model-select').value];
        $('model-meta').hidden = !m;
        if (!m) return;
        setText('meta-params', m.params);
        setText('meta-context', `${fmtInt(m.context_length)} bars`);
        setText('meta-tokenizer', m.tokenizer_id.split('/').pop().replace('Kronos-Tokenizer-', ''));
    }

    async function fetchModelStatus() {
        try {
            const res = await api('/api/model-status');
            if (res.loaded && res.current_model && res.current_model.key) {
                state.model = res.current_model;
                $('model-select').value = state.model.key;
                if (state.model.device) $('device-select').value = state.model.device;
                renderModelMeta();
                log('info', `Server already has ${state.model.name} loaded on ${state.model.device}.`);
            }
        } catch (err) {
            log('warn', `Model status: ${err.message}`);
        }
    }

    async function loadModel() {
        const key = $('model-select').value;
        const device = $('device-select').value;
        const spec = state.models[key];
        if (!spec || state.busy.model) return;

        state.busy.model = true;
        const button = $('load-model-btn');
        setBusy(button, true, 'Loading');
        const started = Date.now();
        const tick = () => panelMessage('model-msg', 'busy',
            `Loading ${spec.name} on ${device}. First use downloads weights from Hugging Face. ${fmtDuration(Date.now() - started)}`);
        tick();
        const timer = setInterval(tick, 1000);
        log('info', `Loading ${spec.name} on ${device}.`);
        render();

        try {
            const res = await api('/api/load-model', { model_key: key, device });
            state.model = res.model_info;
            panelMessage('model-msg', 'ok', `${state.model.name} ready on ${state.model.device} (${fmtDuration(Date.now() - started)}).`);
            log('ok', res.message);
        } catch (err) {
            const network = /huggingface\.co|MaxRetryError|ProxyError|ConnectionError|Temporary failure/i.test(err.message);
            panelMessage('model-msg', 'error', network
                ? 'Could not download model weights from Hugging Face. Check the server can reach huggingface.co, or pre-populate its Hugging Face cache. Full error in the session log.'
                : err.message);
            log('error', err.message);
        } finally {
            clearInterval(timer);
            state.busy.model = false;
            setBusy(button, false, state.model ? 'Reload model' : 'Load model');
            render();
        }
    }

    /* ----------------------------------------------------------------- data */

    async function fetchFiles(announce) {
        const select = $('data-file-select');
        const previous = select.value;
        try {
            state.files = await api('/api/data-files');
        } catch (err) {
            state.files = [];
            panelMessage('data-msg', 'error', `Could not list data files: ${err.message}`);
            log('error', `Data files: ${err.message}`);
        }

        select.textContent = '';
        const groups = new Map();
        state.files.forEach((f) => {
            const source = f.source || 'data';
            if (!groups.has(source)) groups.set(source, []);
            groups.get(source).push(f);
        });
        groups.forEach((files, source) => {
            const group = document.createElement('optgroup');
            group.label = `${source}/`;
            files.forEach((f) => {
                const opt = document.createElement('option');
                opt.value = f.path;
                opt.textContent = `${f.name} · ${f.size}`;
                group.append(opt);
            });
            select.append(group);
        });

        const empty = $('data-empty');
        if (state.files.length === 0) {
            const dirs = state.dataDirs.length ? state.dataDirs : ['data'];
            empty.textContent = '';
            empty.append('No .csv or .feather files found. Add files with open, high, low and close columns to ');
            const code = document.createElement('code');
            code.textContent = `${dirs[0]}/`;
            empty.append(code, ' at the repository root, then rescan.');
            empty.hidden = false;
            select.disabled = true;
        } else {
            empty.hidden = true;
            select.disabled = false;
            if (state.files.some((f) => f.path === previous)) select.value = previous;
        }
        if (announce) log('info', `Found ${state.files.length} data file${state.files.length === 1 ? '' : 's'}.`);
        render();
    }

    async function loadData() {
        const path = $('data-file-select').value;
        const file = state.files.find((f) => f.path === path);
        if (!file || state.busy.data) return;

        state.busy.data = true;
        const button = $('load-data-btn');
        setBusy(button, true, 'Loading');
        panelMessage('data-msg', 'busy', `Reading ${file.name}.`);
        render();

        try {
            const res = await api('/api/load-data', { file_path: path });
            const info = res.data_info;
            state.data = Object.assign({}, info, {
                path,
                name: file.name,
                digits: priceDigits(info.price_range.max),
                resolution: resolutionOf(info.timeframe || ''),
            });
            state.result = null;
            // Fit the window to the data, then place it at the most recent bars.
            const rows = info.rows;
            if (!Number.isInteger(state.lookback) || state.lookback < 2) state.lookback = 400;
            if (!Number.isInteger(state.predLen) || state.predLen < 1) state.predLen = 120;
            if (state.lookback + state.predLen > rows) {
                state.predLen = Math.max(1, Math.min(state.predLen, Math.floor(rows * 0.2)));
                state.lookback = Math.max(2, rows - state.predLen);
            }
            $('lookback').value = state.lookback;
            $('pred-len').value = state.predLen;
            state.start = Math.max(0, rows - state.lookback - state.predLen);
            panelMessage('data-msg', null, '');
            log('ok', `Loaded ${file.name}: ${fmtInt(rows)} rows, ${info.timeframe} bars.`);
            clearResults();
        } catch (err) {
            panelMessage('data-msg', 'error', err.message);
            log('error', err.message);
        } finally {
            state.busy.data = false;
            setBusy(button, false, 'Load data');
            render();
        }
    }

    function renderDataSummary() {
        const d = state.data;
        $('data-summary').hidden = !d;
        if (!d) return;
        setText('data-rows', fmtInt(d.rows));
        setText('data-interval', d.timeframe);
        setText('data-range', `${fmtIso(d.start_date)} → ${fmtIso(d.end_date)}`);
        setText('data-min', fmtPrice(d.price_range.min));
        setText('data-max', fmtPrice(d.price_range.max));
        setText('data-cols', d.prediction_columns.join(', '));
    }

    /* --------------------------------------------------------------- window */

    function windowIssue() {
        if (!state.data) return 'Load a dataset.';
        const { lookback, predLen } = state;
        if (!Number.isInteger(lookback) || lookback < 2) return 'Lookback must be a whole number of at least 2 bars.';
        if (!Number.isInteger(predLen) || predLen < 1) return 'Horizon must be a whole number of at least 1 bar.';
        if (lookback + predLen > state.data.rows) {
            return `Lookback + horizon is ${fmtInt(lookback + predLen)} bars, but the dataset has ${fmtInt(state.data.rows)}.`;
        }
        return null;
    }

    function maxStart() {
        return state.data ? Math.max(0, state.data.rows - state.lookback - state.predLen) : 0;
    }

    function setStart(value) {
        state.start = Math.max(0, Math.min(maxStart(), Math.round(value)));
        renderWindow();
        renderStatus();
    }

    function readLengthInput(id) {
        const raw = $(id).value.trim();
        return raw === '' ? NaN : Number(raw);
    }

    function onLengthInput() {
        state.lookback = readLengthInput('lookback');
        state.predLen = readLengthInput('pred-len');
        if (!windowIssue()) state.start = Math.min(state.start, maxStart());
        render();
    }

    function renderWindow() {
        const d = state.data;
        const issue = windowIssue();
        const valid = d && !issue;
        const range = $('window-start');

        $('lookback').setAttribute('aria-invalid', d && issue && !(Number.isInteger(state.lookback) && state.lookback >= 2) ? 'true' : 'false');
        $('pred-len').setAttribute('aria-invalid', d && issue && !(Number.isInteger(state.predLen) && state.predLen >= 1) ? 'true' : 'false');

        range.disabled = !valid;
        $('window-earliest').disabled = !valid || state.start === 0;
        $('window-latest').disabled = !valid || state.start === maxStart();
        panelMessage('window-msg', 'error', d && issue ? issue : '');

        // The model only reads its context length; anything older is truncated.
        const ctxNote = $('context-note');
        if (state.model && Number.isInteger(state.lookback) && state.lookback > state.model.context_length) {
            ctxNote.hidden = false;
            ctxNote.textContent = `${state.model.name} reads the last ${fmtInt(state.model.context_length)} bars of the lookback.`;
        } else {
            ctxNote.hidden = true;
        }

        if (!valid) {
            setText('readout-context', '—');
            setText('readout-forecast', '—');
            drawOverview();
            return;
        }

        range.max = String(maxStart());
        range.value = String(state.start);
        const ts = d.timestamps;
        const ctxEnd = state.start + state.lookback - 1;
        const fStart = ctxEnd + 1;
        const fEnd = fStart + state.predLen - 1;
        setText('readout-context', `${fmtEpoch(ts[state.start])} → ${fmtEpoch(ts[ctxEnd])} · ${fmtInt(state.lookback)}`);
        setText('readout-forecast', `${fmtEpoch(ts[fStart])} → ${fmtEpoch(ts[fEnd])} · ${fmtInt(state.predLen)}`);
        range.setAttribute('aria-valuetext', `Context starts ${fmtEpoch(ts[state.start])}, forecast ends ${fmtEpoch(ts[fEnd])}`);
        drawOverview();
    }

    function drawOverview() {
        const svg = $('overview-svg');
        const d = state.data;
        $('overview-empty').hidden = !!d;
        svg.textContent = '';
        if (!d) return;

        const rect = svg.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

        const closes = d.overview.close;
        const stride = d.overview.stride;
        let lo = Infinity;
        let hi = -Infinity;
        closes.forEach((c) => { if (c < lo) lo = c; if (c > hi) hi = c; });
        const pad = 6;
        const span = hi - lo || 1;
        const xOf = (row) => (row / Math.max(1, d.rows - 1)) * width;
        const yOf = (c) => pad + (1 - (c - lo) / span) * (height - pad * 2);

        const ns = 'http://www.w3.org/2000/svg';
        if (!windowIssue()) {
            const ctx = document.createElementNS(ns, 'rect');
            const x0 = xOf(state.start);
            const x1 = xOf(state.start + state.lookback);
            const x2 = xOf(state.start + state.lookback + state.predLen - 1);
            ctx.setAttribute('class', 'overview-context');
            ctx.setAttribute('x', x0);
            ctx.setAttribute('y', 0.5);
            ctx.setAttribute('width', Math.max(1, x1 - x0));
            ctx.setAttribute('height', height - 1);
            const fc = document.createElementNS(ns, 'rect');
            fc.setAttribute('class', 'overview-forecast');
            fc.setAttribute('x', x1);
            fc.setAttribute('y', 0.5);
            fc.setAttribute('width', Math.max(1, x2 - x1));
            fc.setAttribute('height', height - 1);
            svg.append(ctx, fc);
        }

        let dAttr = '';
        closes.forEach((c, i) => {
            dAttr += `${i === 0 ? 'M' : 'L'}${xOf(i * stride).toFixed(1)},${yOf(c).toFixed(1)}`;
        });
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('class', 'overview-line');
        path.setAttribute('d', dAttr);
        svg.append(path);
    }

    function bindOverviewDrag() {
        const svg = $('overview-svg');
        let dragging = false;

        const rowAt = (clientX) => {
            const rect = svg.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            return frac * (state.data.rows - 1);
        };
        // Centre the whole window (context + forecast) on the pointer.
        const moveTo = (clientX) => setStart(rowAt(clientX) - (state.lookback + state.predLen) / 2);

        svg.addEventListener('pointerdown', (e) => {
            if (!state.data || windowIssue()) return;
            dragging = true;
            svg.setPointerCapture(e.pointerId);
            moveTo(e.clientX);
        });
        svg.addEventListener('pointermove', (e) => { if (dragging) moveTo(e.clientX); });
        const stop = () => { dragging = false; };
        svg.addEventListener('pointerup', stop);
        svg.addEventListener('pointercancel', stop);
    }

    /* ------------------------------------------------------------- sampling */

    function readSampling() {
        return {
            temperature: parseFloat($('temperature').value),
            topP: parseFloat($('top-p').value),
            samples: state.samples,
        };
    }

    function renderSampling() {
        const s = readSampling();
        setText('temperature-value', s.temperature.toFixed(2));
        setText('top-p-value', s.topP.toFixed(2));
        $('sample-count').querySelectorAll('button').forEach((b) => {
            b.setAttribute('aria-checked', Number(b.dataset.value) === s.samples ? 'true' : 'false');
            b.tabIndex = Number(b.dataset.value) === s.samples ? 0 : -1;
        });
    }

    function setSamples(value) {
        state.samples = Math.max(1, Math.min(5, value));
        renderSampling();
    }

    function resetSampling() {
        $('temperature').value = SAMPLING_DEFAULTS.temperature;
        $('top-p').value = SAMPLING_DEFAULTS.topP;
        setSamples(SAMPLING_DEFAULTS.samples);
    }

    /* -------------------------------------------------------------- predict */

    function runBlocker() {
        if (!state.libraryAvailable) return 'The server cannot run Kronos. See the Model panel.';
        if (state.busy.model) return 'Waiting for the model to load.';
        if (state.busy.data) return 'Waiting for the dataset to load.';
        if (state.busy.predict) return 'Forecast in progress.';
        if (!state.model && !state.data) return 'Load a model and a dataset.';
        if (!state.model) return 'Load a model.';
        if (!state.data) return 'Load a dataset.';
        return windowIssue();
    }

    async function runForecast() {
        if (runBlocker()) return;
        const sampling = readSampling();
        const body = {
            file_path: state.data.path,
            lookback: state.lookback,
            pred_len: state.predLen,
            start_index: state.start,
            temperature: sampling.temperature,
            top_p: sampling.topP,
            sample_count: sampling.samples,
        };

        state.busy.predict = true;
        const button = $('predict-btn');
        setBusy(button, true, 'Running');
        showStage('loading');
        setText('loading-title', `Running ${state.model.name} on ${state.model.device}`);
        setText('loading-meta', `Lookback ${fmtInt(body.lookback)} · horizon ${fmtInt(body.pred_len)} · T ${body.temperature.toFixed(2)} · top-p ${body.top_p.toFixed(2)} · ${body.sample_count} path${body.sample_count > 1 ? 's' : ''}`);
        const started = Date.now();
        const tick = () => setText('loading-elapsed', fmtDuration(Date.now() - started));
        tick();
        const timer = setInterval(tick, 1000);
        log('info', `Forecast started: rows ${fmtInt(body.start_index)}–${fmtInt(body.start_index + body.lookback + body.pred_len - 1)}.`);
        render();

        try {
            const res = await api('/api/predict', body);
            const elapsed = Date.now() - started;
            state.result = Object.assign(res, {
                elapsed,
                finishedAt: nowClock(),
                modelName: state.model.name,
                device: state.model.device,
                fileName: state.data.name,
            });
            showStage(null);
            renderResults();
            log('ok', `Forecast finished in ${fmtDuration(elapsed)}: ${res.prediction_results.length} bars.`);
            if (res.saved_file) log('info', `Saved to webui/prediction_results/${res.saved_file}.`);
        } catch (err) {
            setText('error-text', err.message);
            showStage('error');
            log('error', err.message);
        } finally {
            clearInterval(timer);
            state.busy.predict = false;
            setBusy(button, false, 'Run forecast');
            render();
        }
    }

    function showStage(which) {
        $('stage-loading').hidden = which !== 'loading';
        $('stage-error').hidden = which !== 'error';
        $('stage-empty').hidden = which !== null || !!state.result;
    }

    function dismissError() {
        $('stage-error').hidden = true;
        $('stage-empty').hidden = !!state.result;
    }

    function clearResults() {
        state.result = null;
        state.traces = null;
        if (window.Plotly) {
            Plotly.purge('price-chart');
            Plotly.purge('resid-chart');
        }
        $('metrics').hidden = true;
        $('lower').hidden = true;
        setText('chart-title', 'Price');
        setText('chart-subtitle', '');
        showStage(null);
    }

    /* -------------------------------------------------------------- results */

    function computeMetrics(hist, pred, act) {
        const n = Math.min(pred.length, act.length);
        if (n === 0 || hist.length === 0) return null;
        const ref = hist[hist.length - 1].close;
        let abs = 0;
        let sq = 0;
        let pct = 0;
        let pctN = 0;
        let bias = 0;
        let hits = 0;
        for (let i = 0; i < n; i++) {
            const e = pred[i].close - act[i].close;
            abs += Math.abs(e);
            sq += e * e;
            bias += e;
            if (act[i].close !== 0) {
                pct += Math.abs(e / act[i].close);
                pctN += 1;
            }
            if (Math.sign(pred[i].close - ref) === Math.sign(act[i].close - ref)) hits += 1;
        }
        return {
            n,
            mae: abs / n,
            rmse: Math.sqrt(sq / n),
            mape: pctN ? pct / pctN : NaN,
            bias: bias / n,
            hitRate: hits / n,
            forecastReturn: ref ? pred[n - 1].close / ref - 1 : NaN,
            actualReturn: ref ? act[n - 1].close / ref - 1 : NaN,
        };
    }

    function signedSpan(value) {
        const span = document.createElement('span');
        span.className = value > 0 ? 'pos' : value < 0 ? 'neg' : '';
        span.textContent = fmtPct(value, 2, true);
        return span;
    }

    function renderMetrics(m) {
        $('metrics').hidden = !m;
        if (!m) return;
        const digits = state.data.digits;
        setText('m-mae', fmtNum(m.mae, digits));
        setText('m-rmse', fmtNum(m.rmse, digits));
        setText('m-mape', fmtPct(m.mape));
        setText('m-bias', fmtSigned(m.bias, digits));
        setText('m-bias-sub', m.bias > 0 ? 'forecast above actual' : m.bias < 0 ? 'forecast below actual' : 'no net bias');
        setText('m-hit', fmtPct(m.hitRate, 0));
        setText('m-hit-sub', `vs last close · ${m.n} steps`);
        const horizon = $('m-horizon');
        horizon.textContent = '';
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        horizon.append(signedSpan(m.forecastReturn), sep, signedSpan(m.actualReturn));
    }

    function uniqueLabels(rows) {
        const seen = new Map();
        return rows.map((r) => {
            const base = fmtIso(r.timestamp);
            const count = seen.get(base) || 0;
            seen.set(base, count + 1);
            return count ? `${base} (${count + 1})` : base;
        });
    }

    function ohlcText(rows, withTime) {
        return rows.map((r) => (withTime ? `${fmtIso(r.timestamp)}  ` : '')
            + `O ${fmtPrice(r.open)}  H ${fmtPrice(r.high)}  L ${fmtPrice(r.low)}  C ${fmtPrice(r.close)}`);
    }

    function axisTickFormat() {
        return `,.${Math.max(0, state.data.digits - 1)}f`;
    }

    // Evenly spaced tick indices, inset from the edges so labels are not clipped.
    function tickPositions(count, target) {
        if (count <= target) return Array.from({ length: count }, (_, i) => i);
        return Array.from({ length: target }, (_, i) => Math.round((i + 0.5) * count / target));
    }

    // One label per ~150px of chart width, so labels never collide or rotate.
    function priceTicks(labels) {
        const width = $('price-chart').getBoundingClientRect().width || 800;
        const idx = tickPositions(labels.length, Math.max(2, Math.min(7, Math.floor(width / 150))));
        return idx.map((i) => labels[i]);
    }

    function refitPriceTicks() {
        const chart = $('price-chart');
        if (!state.result || !chart.layout || !chart.layout.xaxis) return;
        const ticks = priceTicks(chart.layout.xaxis.categoryarray);
        Plotly.relayout(chart, { 'xaxis.tickvals': ticks, 'xaxis.ticktext': ticks });
    }

    function baseLayout() {
        return {
            paper_bgcolor: COLORS.panel,
            plot_bgcolor: COLORS.panel,
            font: { family: MONO, size: 11, color: COLORS.muted },
            hoverlabel: {
                bgcolor: COLORS.raised,
                bordercolor: COLORS.borderStrong,
                font: { family: MONO, size: 11, color: COLORS.text },
                align: 'left',
            },
        };
    }

    const PLOT_CONFIG = {
        responsive: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines', 'hoverClosestCartesian', 'hoverCompareCartesian'],
        toImageButtonOptions: { format: 'png', filename: 'kronos-forecast', scale: 2 },
    };

    function renderPriceChart(r) {
        const hist = r.historical_data;
        const act = r.actual_data;
        const pred = r.prediction_results;
        const future = act.length ? act : pred;
        const labels = uniqueLabels(hist.concat(future));
        const histX = labels.slice(0, hist.length);
        const futX = labels.slice(hist.length, hist.length + future.length);
        const predX = futX.slice(0, pred.length);
        const hasVolume = state.data.has_volume && hist.some((b) => b.volume > 0);

        const traces = [];
        const roles = {};
        const add = (role, trace) => { roles[role] = traces.length; traces.push(trace); };

        add('history', {
            type: 'candlestick', name: 'History', x: histX,
            open: hist.map((b) => b.open), high: hist.map((b) => b.high),
            low: hist.map((b) => b.low), close: hist.map((b) => b.close),
            increasing: { line: { color: COLORS.up, width: 1 }, fillcolor: COLORS.up },
            decreasing: { line: { color: COLORS.down, width: 1 }, fillcolor: COLORS.down },
            text: ohlcText(hist, true), hoverinfo: 'text', whiskerwidth: 0,
        });

        if (act.length) {
            add('actual', {
                type: 'candlestick', name: 'Actual', x: futX, opacity: 0.55,
                open: act.map((b) => b.open), high: act.map((b) => b.high),
                low: act.map((b) => b.low), close: act.map((b) => b.close),
                increasing: { line: { color: COLORS.up, width: 1 }, fillcolor: COLORS.up },
                decreasing: { line: { color: COLORS.down, width: 1 }, fillcolor: COLORS.down },
                text: ohlcText(act, true), hoverinfo: 'text', whiskerwidth: 0,
            });
        }

        const band = state.forecastStyle === 'band';
        add('bandHigh', {
            type: 'scatter', mode: 'lines', x: predX, y: pred.map((b) => b.high),
            line: { width: 0, color: COLORS.accent }, hoverinfo: 'skip', showlegend: false,
            legendgroup: 'forecast', visible: band,
        });
        add('bandLow', {
            type: 'scatter', mode: 'lines', name: 'Forecast range', x: predX, y: pred.map((b) => b.low),
            line: { width: 0, color: COLORS.accent }, fill: 'tonexty', fillcolor: COLORS.accentBand,
            hoverinfo: 'skip', legendgroup: 'forecast', visible: band,
        });
        // Start the close line at the last observed close so the handoff is visible.
        const last = hist[hist.length - 1];
        add('close', {
            type: 'scatter', mode: 'lines', name: 'Forecast close',
            x: [histX[histX.length - 1]].concat(predX),
            y: [last.close].concat(pred.map((b) => b.close)),
            line: { width: 1.75, color: COLORS.accent },
            text: [`Last close ${fmtPrice(last.close)}`].concat(ohlcText(pred)),
            hoverinfo: 'text', legendgroup: 'forecast', visible: band,
        });
        add('candles', {
            type: 'candlestick', name: 'Forecast', x: predX,
            open: pred.map((b) => b.open), high: pred.map((b) => b.high),
            low: pred.map((b) => b.low), close: pred.map((b) => b.close),
            increasing: { line: { color: COLORS.accent, width: 1 }, fillcolor: 'rgba(0,0,0,0)' },
            decreasing: { line: { color: COLORS.accent, width: 1 }, fillcolor: COLORS.accent },
            text: ohlcText(pred), hoverinfo: 'text', whiskerwidth: 0, visible: !band,
        });

        if (hasVolume) {
            add('volHist', {
                type: 'bar', name: 'Volume', x: histX, y: hist.map((b) => b.volume), yaxis: 'y2',
                marker: { color: COLORS.volHist }, hovertemplate: 'Vol %{y:.3s}<extra></extra>', showlegend: false,
            });
            if (act.length) {
                add('volActual', {
                    type: 'bar', name: 'Actual volume', x: futX, y: act.map((b) => b.volume), yaxis: 'y2',
                    marker: { color: COLORS.volActual }, hovertemplate: 'Vol %{y:.3s}<extra></extra>', showlegend: false,
                });
            }
            add('volForecast', {
                type: 'scatter', mode: 'lines', name: 'Forecast volume', x: predX, y: pred.map((b) => b.volume), yaxis: 'y2',
                line: { width: 1.25, color: COLORS.accent }, hovertemplate: 'Fcst vol %{y:.3s}<extra></extra>', showlegend: false,
            });
        }

        const ticks = priceTicks(labels);
        const splitX = hist.length - 0.5;
        const layout = Object.assign(baseLayout(), {
            margin: { l: 8, r: 70, t: 30, b: 30 },
            hovermode: 'x unified',
            dragmode: 'zoom',
            showlegend: true,
            legend: {
                orientation: 'h', x: 0, xanchor: 'left', y: 1.01, yanchor: 'bottom',
                font: { family: MONO, size: 11, color: COLORS.muted }, bgcolor: 'rgba(0,0,0,0)',
                itemclick: 'toggle', itemdoubleclick: 'toggleothers', traceorder: 'normal',
            },
            xaxis: {
                type: 'category',
                categoryorder: 'array',
                categoryarray: labels,
                tickmode: 'array',
                tickvals: ticks,
                ticktext: ticks,
                tickangle: 0,
                showgrid: false,
                linecolor: COLORS.border,
                tickcolor: COLORS.border,
                ticklen: 4,
                rangeslider: { visible: false },
                showspikes: true,
                spikemode: 'across',
                spikesnap: 'cursor',
                spikecolor: COLORS.faint,
                spikethickness: 1,
                spikedash: 'dot',
            },
            yaxis: {
                domain: hasVolume ? [0.25, 1] : [0, 1],
                side: 'right',
                type: state.scale,
                gridcolor: COLORS.grid,
                zeroline: false,
                tickformat: axisTickFormat(),
                showspikes: true,
                spikemode: 'across',
                spikesnap: 'cursor',
                spikecolor: COLORS.faint,
                spikethickness: 1,
                spikedash: 'dot',
            },
            shapes: [
                {
                    type: 'rect', xref: 'x', yref: 'paper', x0: splitX, x1: labels.length - 0.5, y0: 0, y1: 1,
                    fillcolor: COLORS.accentRegion, line: { width: 0 }, layer: 'below',
                },
                {
                    type: 'line', xref: 'x', yref: 'paper', x0: splitX, x1: splitX, y0: 0, y1: 1,
                    line: { color: COLORS.accent, width: 1, dash: 'dot' },
                },
            ],
            annotations: [{
                xref: 'x', yref: 'paper', x: splitX, y: hasVolume ? 0.25 : 0, yanchor: 'bottom', xanchor: 'left',
                text: ' forecast', showarrow: false, font: { family: MONO, size: 10, color: COLORS.accent },
            }],
        });

        if (hasVolume) {
            layout.yaxis2 = {
                domain: [0, 0.18],
                side: 'right',
                gridcolor: COLORS.grid,
                zeroline: false,
                tickformat: '.2s',
                nticks: 3,
            };
            layout.bargap = 0.25;
        }

        state.traces = roles;
        return Plotly.react('price-chart', traces, layout, PLOT_CONFIG);
    }

    function renderResidualChart(r) {
        const pred = r.prediction_results;
        const act = r.actual_data;
        const n = Math.min(pred.length, act.length);
        const steps = [];
        const errs = [];
        const text = [];
        const colors = [];
        for (let i = 0; i < n; i++) {
            const e = pred[i].close - act[i].close;
            steps.push(i + 1);
            errs.push(e);
            colors.push(e >= 0 ? COLORS.accent : COLORS.context);
            const pct = act[i].close ? e / act[i].close : NaN;
            text.push(`Step ${i + 1} · ${fmtIso(act[i].timestamp)}<br>Error ${fmtSigned(e, state.data.digits)} (${fmtPct(pct, 2, true)})`);
        }

        const layout = Object.assign(baseLayout(), {
            margin: { l: 8, r: 64, t: 10, b: 30 },
            hovermode: 'closest',
            showlegend: false,
            bargap: n > 60 ? 0.1 : 0.3,
            xaxis: {
                title: { text: 'step', font: { size: 10, color: COLORS.faint }, standoff: 4 },
                showgrid: false, linecolor: COLORS.border, tickcolor: COLORS.border, ticklen: 4,
                zeroline: false, range: [0.5, n + 0.5],
            },
            yaxis: {
                side: 'right', gridcolor: COLORS.grid, zeroline: true, zerolinecolor: COLORS.borderStrong,
                tickformat: axisTickFormat(), nticks: 5,
            },
        });
        return Plotly.react('resid-chart', [{
            type: 'bar', x: steps, y: errs, marker: { color: colors }, text, hoverinfo: 'text', textposition: 'none',
        }], layout, Object.assign({}, PLOT_CONFIG, { displayModeBar: false }));
    }

    function renderTable(r) {
        const pred = r.prediction_results;
        const act = r.actual_data;
        const n = Math.min(pred.length, act.length);
        const body = $('table-body');
        const frag = document.createDocumentFragment();
        const cell = (text, cls) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (cls) td.className = cls;
            return td;
        };
        for (let i = 0; i < n; i++) {
            const p = pred[i];
            const a = act[i];
            const e = p.close - a.close;
            const pct = a.close ? e / a.close : NaN;
            const sign = e > 0 ? 'pos' : e < 0 ? 'neg' : '';
            const tr = document.createElement('tr');
            tr.append(
                cell(String(i + 1)),
                cell(fmtIso(a.timestamp)),
                cell(fmtPrice(p.open), 'fcst grp'), cell(fmtPrice(a.open)),
                cell(fmtPrice(p.high), 'fcst grp'), cell(fmtPrice(a.high)),
                cell(fmtPrice(p.low), 'fcst grp'), cell(fmtPrice(a.low)),
                cell(fmtPrice(p.close), 'fcst grp'), cell(fmtPrice(a.close)),
                cell(fmtSigned(e, state.data.digits), `grp ${sign}`),
                cell(fmtPct(pct, 2, true), sign),
            );
            frag.append(tr);
        }
        body.textContent = '';
        body.append(frag);
    }

    function renderResults() {
        const r = state.result;
        if (!r) return;
        const w = r.window;
        const hist = r.historical_data;
        const future = r.actual_data.length ? r.actual_data : r.prediction_results;
        setText('chart-title', state.data.name);
        setText('chart-subtitle',
            `${state.data.timeframe} · context ${fmtIso(hist[0].timestamp)} → ${fmtIso(hist[hist.length - 1].timestamp)} · forecast ${w.pred_len} bars to ${fmtIso(future[future.length - 1].timestamp)}`);

        $('stage-empty').hidden = true;
        const hasComparison = r.has_comparison;
        $('lower').hidden = !hasComparison;
        renderMetrics(hasComparison ? computeMetrics(hist, r.prediction_results, r.actual_data) : null);
        renderPriceChart(r);
        if (hasComparison) {
            renderResidualChart(r);
            renderTable(r);
        }
        if (w.effective_context < w.lookback) {
            log('info', `Model context is ${fmtInt(w.effective_context)} bars; earlier lookback bars were truncated.`);
        }
    }

    function setForecastStyle(style) {
        state.forecastStyle = style;
        document.querySelectorAll('[data-forecast-style]').forEach((b) => {
            b.setAttribute('aria-pressed', b.dataset.forecastStyle === style ? 'true' : 'false');
        });
        if (!state.result || !state.traces) return;
        const t = state.traces;
        const band = style === 'band';
        Plotly.restyle('price-chart', { visible: band }, [t.bandHigh, t.bandLow, t.close]);
        Plotly.restyle('price-chart', { visible: !band }, [t.candles]);
    }

    function setScale(scale) {
        state.scale = scale;
        document.querySelectorAll('[data-scale]').forEach((b) => {
            b.setAttribute('aria-pressed', b.dataset.scale === scale ? 'true' : 'false');
        });
        if (state.result) Plotly.relayout('price-chart', { 'yaxis.type': scale, 'yaxis.autorange': true });
    }

    function exportCsv() {
        const r = state.result;
        if (!r) return;
        const pred = r.prediction_results;
        const act = r.actual_data;
        const header = ['step', 'timestamp',
            'open_forecast', 'open_actual', 'high_forecast', 'high_actual',
            'low_forecast', 'low_actual', 'close_forecast', 'close_actual',
            'volume_forecast', 'volume_actual', 'close_error', 'close_error_pct'];
        const lines = [header.join(',')];
        for (let i = 0; i < pred.length; i++) {
            const p = pred[i];
            const a = act[i];
            const e = a ? p.close - a.close : '';
            const pct = a && a.close ? (p.close - a.close) / a.close * 100 : '';
            lines.push([
                i + 1, a ? a.timestamp : p.timestamp,
                p.open, a ? a.open : '', p.high, a ? a.high : '',
                p.low, a ? a.low : '', p.close, a ? a.close : '',
                p.volume, a ? a.volume : '', e, pct,
            ].join(','));
        }
        const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stem = state.data.name.replace(/\.[^.]+$/, '');
        link.href = url;
        link.download = `kronos_${stem}_row${r.window.start_index}_${r.window.lookback}x${r.window.pred_len}.csv`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        log('info', `Exported ${pred.length} rows to ${link.download}.`);
    }

    /* --------------------------------------------------------------- render */

    function renderStatus() {
        const modelBusy = state.busy.model;
        const modelState = modelBusy ? 'busy' : state.model ? 'ok' : 'idle';
        $('sb-model-dot').dataset.state = modelState;
        setText('sb-model', modelBusy ? 'Loading…' : state.model ? `${state.model.name} · ${state.model.device}` : 'Not loaded');
        const tag = $('model-tag');
        tag.dataset.state = modelState;
        tag.textContent = modelBusy ? 'Loading' : state.model ? `${state.model.name} · ${state.model.device}` : 'Not loaded';

        $('sb-data-dot').dataset.state = state.busy.data ? 'busy' : state.data ? 'ok' : 'idle';
        setText('sb-data', state.busy.data ? 'Loading…' : state.data ? `${state.data.name} · ${fmtInt(state.data.rows)} rows` : 'None');

        const d = state.data;
        if (d && !windowIssue()) {
            const fEnd = state.start + state.lookback + state.predLen - 1;
            setText('sb-window', `${fmtEpoch(d.timestamps[state.start])} → ${fmtEpoch(d.timestamps[fEnd])} · ${fmtInt(state.lookback)} + ${fmtInt(state.predLen)}`);
        } else {
            setText('sb-window', '—');
        }

        const r = state.result;
        setText('sb-run', state.busy.predict ? 'Running…' : r ? `${r.finishedAt} · ${fmtDuration(r.elapsed)} · ${r.modelName}` : '—');

        // Empty-stage checklist mirrors the setup state.
        const check = (id, ok, detail, error) => {
            const li = $(id);
            li.dataset.state = error ? 'error' : ok ? 'ok' : 'pending';
            li.querySelector('.check-detail').textContent = detail;
        };
        check('check-model', !!state.model,
            state.model ? `${state.model.name} on ${state.model.device}` : modelBusy ? 'Loading…' : state.libraryAvailable ? 'Not loaded' : 'Unavailable on server',
            !state.libraryAvailable && !modelBusy);
        check('check-data', !!d, d ? `${d.name} · ${fmtInt(d.rows)} rows` : state.busy.data ? 'Loading…' : 'Not loaded', false);
        const issue = windowIssue();
        check('check-window', d && !issue, !d ? 'Waiting for data' : issue ? 'Invalid' : `${fmtInt(state.lookback)} + ${fmtInt(state.predLen)} bars`, d && !!issue);
    }

    function render() {
        const libOk = state.libraryAvailable && Object.keys(state.models).length > 0;
        $('load-model-btn').disabled = !libOk || state.busy.model || state.busy.predict;
        $('model-select').disabled = !libOk || state.busy.model;
        $('device-select').disabled = !libOk || state.busy.model;

        const hasFiles = state.files.length > 0;
        $('load-data-btn').disabled = !hasFiles || state.busy.data || state.busy.predict;
        $('data-file-select').disabled = !hasFiles || state.busy.data;
        $('rescan-btn').disabled = state.busy.data;

        const blocker = runBlocker();
        $('predict-btn').disabled = !!blocker;
        const reason = $('run-reason');
        reason.textContent = blocker || 'Ready.';
        reason.dataset.level = blocker && state.data && windowIssue() ? 'error' : '';

        const hasResult = !!state.result;
        document.querySelectorAll('#chart-toolbar button').forEach((b) => { b.disabled = !hasResult; });
        $('export-btn').disabled = !hasResult || !state.result.has_comparison;

        renderDataSummary();
        renderWindow();
        renderSampling();
        renderStatus();
    }

    /* --------------------------------------------------------------- events */

    function bindEvents() {
        $('model-select').addEventListener('change', () => { renderModelMeta(); render(); });
        $('load-model-btn').addEventListener('click', loadModel);

        $('rescan-btn').addEventListener('click', () => fetchFiles(true));
        $('load-data-btn').addEventListener('click', loadData);

        $('lookback').addEventListener('input', onLengthInput);
        $('pred-len').addEventListener('input', onLengthInput);
        $('window-start').addEventListener('input', (e) => setStart(Number(e.target.value)));
        $('window-earliest').addEventListener('click', () => setStart(0));
        $('window-latest').addEventListener('click', () => setStart(maxStart()));
        bindOverviewDrag();

        $('temperature').addEventListener('input', renderSampling);
        $('top-p').addEventListener('input', renderSampling);
        const samples = $('sample-count');
        samples.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (b) setSamples(Number(b.dataset.value));
        });
        samples.addEventListener('keydown', (e) => {
            const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
            if (!delta) return;
            e.preventDefault();
            setSamples(state.samples + delta);
            samples.querySelector('[aria-checked="true"]').focus();
        });
        $('sampling-reset').addEventListener('click', resetSampling);

        $('predict-btn').addEventListener('click', runForecast);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                runForecast();
            }
        });

        document.querySelectorAll('[data-forecast-style]').forEach((b) => {
            b.addEventListener('click', () => setForecastStyle(b.dataset.forecastStyle));
        });
        document.querySelectorAll('[data-scale]').forEach((b) => {
            b.addEventListener('click', () => setScale(b.dataset.scale));
        });
        $('error-dismiss').addEventListener('click', dismissError);
        $('export-btn').addEventListener('click', exportCsv);
        $('log-clear').addEventListener('click', clearLog);

        let resizeFrame = 0;
        window.addEventListener('resize', () => {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                drawOverview();
                refitPriceTicks();
            });
        });
    }

    async function init() {
        clearLog();
        if (/Mac|iPhone|iPad/.test(navigator.platform)) setText('run-kbd', 'Cmd Enter');
        bindEvents();
        if (!window.Plotly) {
            log('error', 'Plotly failed to load from /vendor/plotly.min.js; charts are unavailable.');
        }
        render();
        await fetchCatalogue();
        await Promise.all([fetchModelStatus(), fetchFiles(false)]);
        render();
        log('info', 'Workspace ready.');
    }

    document.addEventListener('DOMContentLoaded', init);
})();
