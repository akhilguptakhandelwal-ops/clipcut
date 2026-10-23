'use strict';
// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const FONT = 'Calibri, Carlito, "Segoe UI", "Noto Sans", sans-serif';

function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (['value', 'checked', 'disabled'].includes(k)) e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
}

function toast(msg, opts = {}) {
    const t = el('div', { class: 'toast' + (opts.err ? ' err' : '') }, msg);
    $('#toasts').append(t);
    if (!opts.sticky) setTimeout(() => t.remove(), opts.ms || 3500);
    return t;
}

// ---------------------------------------------------------------- state
const S = {
    media: new Map(), clips: [], texts: [], music: null,
    t: 0, playing: false, sel: null, zoom: 60,
    cropMode: false, cropLock: null,
    exp: { size: 'source', fast: true },
};
let seq = 0;
const uid = () => ++seq;
const mediaOf = c => S.media.get(c.mediaId);
const clipDur = c => (mediaOf(c).kind === 'image' ? c.duration : (c.out - c.in) / c.speed);

function layout() {
    let t = 0;
    const items = S.clips.map(c => { const dur = clipDur(c); const it = { c, start: t, dur }; t += dur; return it; });
    return { items, total: t };
}
const selClip = () => S.sel && S.sel.type === 'clip' ? S.clips.find(c => c.uid === S.sel.uid) : null;
const selText = () => S.sel && S.sel.type === 'text' ? S.texts.find(t => t.uid === S.sel.uid) : null;

// undo / redo over the editable parts of the project
const undoStack = [], redoStack = [];
const snapshot = () => JSON.stringify({ clips: S.clips, texts: S.texts, music: S.music });
function commit() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
function restore(json) {
    const p = JSON.parse(json);
    S.clips = p.clips; S.texts = p.texts; S.music = p.music;
    S.cropMode = false; S.sel = null;
    refreshAll();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// ---------------------------------------------------------------- importing
function uploadFile(file, name, onProgress) {
    return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', '/api/upload?name=' + encodeURIComponent(name || file.name));
        x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
        x.onload = () => {
            let j = {};
            try { j = JSON.parse(x.responseText); } catch (e) { /* non-JSON error page */ }
            x.status === 200 ? resolve(j) : reject(new Error(j.error || 'Upload failed'));
        };
        x.onerror = () => reject(new Error('Upload failed'));
        x.send(file);
    });
}

async function importFiles(files) {
    for (const file of files) {
        const t = toast(`Importing ${file.name}…`, { sticky: true });
        try {
            const m = await uploadFile(file, file.name, p => (t.textContent = `Importing ${file.name}… ${Math.round(p * 100)}%`));
            S.media.set(m.id, m);
            renderBin();
        } catch (e) {
            toast(`${file.name}: ${e.message}`, { err: true, ms: 6000 });
        }
        t.remove();
    }
}

function addToTimeline(id) {
    const m = S.media.get(id);
    if (m.kind === 'audio') return setMusic(id);
    commit();
    const c = m.kind === 'image'
        ? { uid: uid(), mediaId: id, in: 0, out: 5, duration: 5, speed: 1, crop: null, mute: true, volume: 1 }
        : { uid: uid(), mediaId: id, in: 0, out: m.duration, speed: 1, crop: null, mute: false, volume: 1 };
    S.clips.push(c);
    const it = layout().items.find(i => i.c === c);
    S.sel = { type: 'clip', uid: c.uid };
    S.t = it.start;
    refreshAll();
}

function setMusic(id) {
    commit();
    S.music = { mediaId: id, volume: 0.6, orig: 1, mode: 'mix' };
    S.sel = { type: 'music' };
    refreshAll();
}

// ---------------------------------------------------------------- media bin
function renderBin() {
    const list = $('#binList');
    list.replaceChildren();
    if (!S.media.size) list.append(el('div', { class: 'hint' }, 'Drop videos, photos or music anywhere in this window, or press Import.'));
    for (const m of S.media.values()) {
        const th = el('div', { class: 'th', style: m.kind === 'audio' ? '' : `background-image:url(/api/thumb/${m.id})` }, m.kind === 'audio' ? '♪' : '');
        list.append(el('div', { class: 'media', ondblclick: () => addToTimeline(m.id) },
            th,
            el('div', { class: 'nm' }, el('b', { title: m.name }, m.name),
                el('span', {}, m.kind === 'image' ? 'Photo' : `${m.kind === 'audio' ? 'Music' : 'Video'} · ${fmt(m.duration)}`)),
            el('button', { title: m.kind === 'audio' ? 'Use as music' : 'Add to timeline', onclick: () => addToTimeline(m.id) }, m.kind === 'audio' ? '♪+' : '+')));
    }
}

// ---------------------------------------------------------------- preview
const vid = $('#vid'), img = $('#img'), mus = $('#mus');
let loadedClip = null, loadedMedia = null;

function outAspect() {
    const o = S.exp.size;
    if (o === '1080p' || o === '720p') return 16 / 9;
    if (o === 'vertical') return 9 / 16;
    if (o === 'square') return 1;
    const c = S.clips[0];
    if (!c) return 16 / 9;
    const m = mediaOf(c), cr = c.crop || { w: 1, h: 1 };
    return (m.width * cr.w) / (m.height * cr.h);
}

function sizeFrame() {
    const st = $('#stage');
    const aw = st.clientWidth - 28, ah = st.clientHeight - 28, ar = outAspect();
    const fw = Math.max(40, Math.min(aw, ah * ar)), fh = fw / ar;
    const f = $('#frame');
    f.style.width = fw + 'px'; f.style.height = fh + 'px';
    S.fw = fw; S.fh = fh;
}

function curItem(t) {
    const L = layout();
    if (!L.items.length) return null;
    for (const it of L.items) if (t < it.start + it.dur - 1e-6) return it;
    return L.items[L.items.length - 1];
}

function placeMedia(c, m) {
    const editing = S.cropMode && selClip() === c;
    const cr = editing || !c.crop ? { x: 0, y: 0, w: 1, h: 1 } : c.crop;
    const arc = (m.width * cr.w) / (m.height * cr.h);
    let bw = S.fw, bh = S.fw / arc;
    if (bh > S.fh) { bh = S.fh; bw = S.fh * arc; }
    const box = $('#clipbox');
    Object.assign(box.style, { width: bw + 'px', height: bh + 'px', left: (S.fw - bw) / 2 + 'px', top: (S.fh - bh) / 2 + 'px' });
    for (const e of [vid, img]) {
        Object.assign(e.style, { width: bw / cr.w + 'px', height: bh / cr.h + 'px', left: -cr.x * bw / cr.w + 'px', top: -cr.y * bh / cr.h + 'px' });
    }
    const cropEl = $('#crop');
    cropEl.hidden = !editing;
    if (editing && c.crop) positionCropEl(c.crop);
    else if (editing) positionCropEl({ x: 0, y: 0, w: 1, h: 1 });
}

function showAt(t, force) {
    const L = layout();
    S.t = clamp(t, 0, L.total);
    sizeFrame();
    const it = curItem(S.t);
    $('#empty').hidden = !!it;
    if (!it) {
        vid.hidden = img.hidden = true;
        if (loadedMedia) { vid.removeAttribute('src'); vid.load(); loadedMedia = loadedClip = null; }
        $('#crop').hidden = true;
        renderOverlays(); updateChrome();
        return;
    }
    const c = it.c, m = mediaOf(c);
    placeMedia(c, m);
    if (m.kind === 'image') {
        vid.pause(); vid.hidden = true; img.hidden = false;
        if (img.dataset.id !== m.id) { img.src = '/api/media/' + m.id; img.dataset.id = m.id; }
    } else {
        img.hidden = true; vid.hidden = false;
        if (loadedMedia !== m.id) { vid.src = '/api/media/' + m.id; force = true; }
        vid.playbackRate = clamp(c.speed, 0.0625, 16);
        vid.muted = c.mute || (S.music && S.music.mode === 'replace');
        vid.volume = clamp(c.volume, 0, 1);
        const target = c.in + (S.t - it.start) * c.speed;
        const diff = Math.abs(vid.currentTime - target);
        if (force || (loadedClip !== c.uid && diff > 0.15) || (!S.playing && diff > 0.04)) vid.currentTime = target;
    }
    loadedMedia = m.kind === 'image' ? loadedMedia : m.id;
    loadedClip = c.uid;
    renderOverlays();
    updateChrome();
}

function updateChrome() {
    $('#clock').textContent = `${fmt(S.t)} / ${fmt(layout().total)}`;
    $('#playhead') && ($('#playhead').style.left = S.t * S.zoom + 'px');
    $('#play').textContent = S.playing ? '❚❚' : '▶';
}

// ---- captions: rendered once to a canvas; the same canvas is previewed and exported as a PNG
const textKey = t => JSON.stringify([t.text, t.size, t.color, t.box, t.bold]);
const canvasCache = new Map();
function textCanvas(t) {
    const key = textKey(t);
    const hit = canvasCache.get(t.uid);
    if (hit && hit.key === key) return hit.canvas;
    const fs = t.size / 100 * 1080, pad = fs * 0.3, lh = fs * 1.25;
    const font = `${t.bold ? '700 ' : ''}${fs}px ${FONT}`;
    const lines = String(t.text).split('\n');
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const w = Math.ceil(Math.max(...lines.map(l => probe.measureText(l).width)) + pad * 2);
    const h = Math.ceil(lines.length * lh + pad * 2);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    if (t.box) {
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.beginPath(); g.roundRect(0, 0, w, h, fs * 0.2); g.fill();
    }
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = t.color;
    g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowOffsetX = g.shadowOffsetY = fs * 0.03; g.shadowBlur = fs * 0.04;
    lines.forEach((l, i) => g.fillText(l, w / 2, pad + lh * (i + 0.5)));
    canvasCache.set(t.uid, { key, canvas });
    return canvas;
}

let overlaySig = '';
function renderOverlays() {
    const active = S.texts.filter(t => String(t.text).trim() && S.t >= t.start && S.t < t.start + t.dur);
    const sig = active.map(t => t.uid + textKey(t) + t.pos).join('|') + '@' + Math.round(S.fh);
    if (sig === overlaySig) return;
    overlaySig = sig;
    const scale = S.fh / 1080;
    $('#overlays').replaceChildren(...active.map(t => {
        const c = textCanvas(t);
        const pos = t.pos === 'top' ? `top:${S.fh * 0.06}px` : t.pos === 'middle' ? `top:${(S.fh - c.height * scale) / 2}px` : `bottom:${S.fh * 0.06}px`;
        const holder = el('div', { style: `position:absolute;left:0;right:0;${pos};height:${c.height * scale}px` });
        c.style.cssText = `position:absolute;left:50%;transform:translateX(-50%);width:${c.width * scale}px;height:${c.height * scale}px`;
        holder.append(c);
        return holder;
    }));
}

// ---- playback
let lastTs = 0;
function play() {
    const L = layout();
    if (!L.items.length) return;
    if (S.t >= L.total - 0.02) S.t = 0;
    S.playing = true;
    lastTs = performance.now();
    showAt(S.t, true);
    startMusic();
    requestAnimationFrame(tick);
}
function pause() {
    S.playing = false;
    vid.pause(); mus.pause();
    updateChrome();
}
function startMusic() {
    if (!S.music || !S.playing) return;
    const m = S.media.get(S.music.mediaId);
    if (mus.dataset.id !== m.id) { mus.src = '/api/media/' + m.id; mus.dataset.id = m.id; }
    mus.volume = clamp(S.music.volume, 0, 1);
    mus.currentTime = m.duration ? S.t % m.duration : 0;
    mus.loop = true;
    mus.play().catch(() => {});
}
function tick(now) {
    if (!S.playing) return;
    const dt = Math.min(0.1, (now - lastTs) / 1000); lastTs = now;
    const L = layout();
    const it = curItem(S.t);
    let t = S.t;
    if (!it) return pause();
    if (mediaOf(it.c).kind === 'video') {
        if (loadedClip === it.c.uid && vid.readyState >= 2 && !vid.seeking) {
            t = it.start + (vid.currentTime - it.c.in) / it.c.speed;
            if (vid.currentTime >= it.c.out - 0.03 || vid.ended) t = it.start + it.dur + 0.001;
        }
    } else if (loadedClip === it.c.uid) t += dt;
    if (t >= L.total - 0.005) { showAt(L.total, false); pause(); return; }
    showAt(t, false);
    if (!vid.hidden && vid.paused && vid.readyState >= 1) vid.play().catch(() => {});
    requestAnimationFrame(tick);
}
function seek(t) {
    showAt(t, true);
    if (S.playing) startMusic();
}

// ---------------------------------------------------------------- timeline
const tlEl = $('#tl'), scrollEl = $('#scroll');
const TRACKS = { video: { top: 32, h: 60 }, text: { top: 98, h: 44 }, music: { top: 148, h: 44 } };

function dragPointer(e, move, end) {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const mv = ev => move(ev.clientX - sx, ev.clientY - sy, ev);
    const up = ev => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        end && end(ev.clientX - sx, ev.clientY - sy, ev);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
}
const tlX = e => e.clientX - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft;

function select(type, id) {
    if (S.cropMode && !(type === 'clip' && S.sel && S.sel.uid === id)) S.cropMode = false;
    S.sel = type ? { type, uid: id } : null;
    for (const b of tlEl.querySelectorAll('.blk')) b.classList.toggle('sel', !!S.sel && b.dataset.type === S.sel.type && (b.dataset.uid == (S.sel.uid ?? b.dataset.uid)));
    renderProps();
    showAt(S.t, true);
}

function renderTimeline() {
    const Z = S.zoom, L = layout();
    const musicEnd = S.music ? L.total : 0;
    const width = Math.max(L.total + 15, 30) * Z;
    tlEl.replaceChildren();
    tlEl.style.width = width + 'px';

    const ruler = el('div', { id: 'ruler' });
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s * Z >= 70) || 600;
    for (let s = 0; s * Z < width; s += step) ruler.append(el('div', { class: 'tick', style: `left:${s * Z}px` }, fmt(s).replace(/\.0$/, '')));
    ruler.onpointerdown = e => {
        const go = ev => seek(clamp((ev.clientX - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft) / Z, 0, L.total));
        go(e);
        dragPointer(e, (dx, dy, ev) => go(ev));
    };
    tlEl.append(ruler);

    const mk = (name) => { const t = TRACKS[name]; const d = el('div', { class: 'track', style: `top:${t.top}px;height:${t.h}px` }); tlEl.append(d); return d; };
    const vTrack = mk('video'), tTrack = mk('text'), mTrack = mk('music');

    // video clips
    for (const it of L.items) {
        const c = it.c, m = mediaOf(c);
        const b = el('div', {
            class: 'blk v' + (S.sel && S.sel.type === 'clip' && S.sel.uid === c.uid ? ' sel' : ''), 'data-type': 'clip', 'data-uid': c.uid,
            style: `left:${it.start * Z}px;width:${Math.max(6, it.dur * Z)}px;background-image:url(/api/thumb/${m.id})`,
        },
        el('div', { class: 'cap' }, m.name),
        el('div', { class: 'sub' }, `${fmt(it.dur)}${c.speed !== 1 ? ` · ${c.speed}×` : ''}${c.crop ? ' · cropped' : ''}${c.mute && m.kind === 'video' ? ' · muted' : ''}`),
        trimHandle(c, 'l'), trimHandle(c, 'r'));
        b.onpointerdown = e => {
            if (e.target.classList.contains('h')) return;
            select('clip', c.uid);
            const left0 = it.start * Z;
            let moved = false;
            dragPointer(e, dx => {
                if (Math.abs(dx) > 4) moved = true;
                if (moved) { b.style.left = Math.max(0, left0 + dx) + 'px'; b.style.zIndex = 5; b.style.opacity = .85; }
            }, dx => {
                if (!moved) { seek(clamp(tlX(e) / Z, it.start, it.start + it.dur - 0.001)); return; }
                const center = left0 + dx + it.dur * Z / 2;
                const idx = L.items.filter(o => o.c !== c && (o.start + o.dur / 2) * Z < center).length;
                const from = S.clips.indexOf(c);
                if (idx !== from) { commit(); S.clips.splice(from, 1); S.clips.splice(idx, 0, c); }
                renderTimeline(); showAt(S.t, true);
            });
        };
        vTrack.append(b);
    }

    // text blocks
    for (const t of S.texts) {
        const b = el('div', {
            class: 'blk t' + (S.sel && S.sel.type === 'text' && S.sel.uid === t.uid ? ' sel' : ''), 'data-type': 'text', 'data-uid': t.uid,
            style: `left:${t.start * Z}px;width:${Math.max(10, t.dur * Z)}px`,
        }, el('div', { class: 'cap', style: 'top:12px' }, String(t.text).split('\n')[0] || '(empty)'), textHandle(t, 'l'), textHandle(t, 'r'));
        b.onpointerdown = e => {
            if (e.target.classList.contains('h')) return;
            select('text', t.uid);
            const s0 = t.start; let moved = false;
            dragPointer(e, dx => {
                if (Math.abs(dx) > 3 && !moved) { moved = true; commit(); }
                if (moved) { t.start = Math.max(0, s0 + dx / Z); b.style.left = t.start * Z + 'px'; showAt(S.t, true); }
            }, () => { if (!moved) seek(clamp(tlX(e) / Z, 0, L.total)); else renderProps(); });
        };
        tTrack.append(b);
    }

    // music
    if (S.music) {
        const m = S.media.get(S.music.mediaId);
        const b = el('div', {
            class: 'blk m' + (S.sel && S.sel.type === 'music' ? ' sel' : ''), 'data-type': 'music',
            style: `left:0;width:${Math.max(30, musicEnd * Z)}px`,
        }, el('div', { class: 'cap', style: 'top:12px' }, '♪ ' + m.name));
        b.onpointerdown = e => { select('music'); seek(clamp(tlX(e) / Z, 0, L.total)); };
        mTrack.append(b);
    }

    tlEl.append(el('div', { id: 'playhead', style: `left:${S.t * Z}px` }));
}

function trimHandle(c, side) {
    return el('div', {
        class: 'h ' + side,
        onpointerdown: e => {
            e.stopPropagation();
            select('clip', c.uid);
            commit();
            const m = mediaOf(c), i0 = c.in, o0 = c.out, d0 = c.duration;
            dragPointer(e, dx => {
                const ds = dx / S.zoom;
                if (m.kind === 'image') c.duration = c.out = clamp(side === 'l' ? d0 - ds : d0 + ds, 0.2, 3600);
                else if (side === 'l') c.in = clamp(i0 + ds * c.speed, 0, o0 - 0.1);
                else c.out = clamp(o0 + ds * c.speed, i0 + 0.1, m.duration);
                renderTimeline(); showAt(S.t, true); renderProps();
            });
        },
    });
}
function textHandle(t, side) {
    return el('div', {
        class: 'h ' + side,
        onpointerdown: e => {
            e.stopPropagation();
            select('text', t.uid);
            commit();
            const s0 = t.start, d0 = t.dur;
            dragPointer(e, dx => {
                const ds = dx / S.zoom;
                if (side === 'l') { const ns = clamp(s0 + ds, 0, s0 + d0 - 0.2); t.dur = d0 - (ns - s0); t.start = ns; }
                else t.dur = Math.max(0.2, d0 + ds);
                renderTimeline(); showAt(S.t, true); renderProps();
            });
        },
    });
}

// timeline actions
function splitAtPlayhead() {
    const L = layout();
    const it = L.items.find(i => S.t > i.start + 0.1 && S.t < i.start + i.dur - 0.1);
    if (!it) return toast('Move the playhead inside a clip to split it.');
    commit();
    const c = it.c, m = mediaOf(c);
    const b = { ...c, uid: uid(), crop: c.crop && { ...c.crop } };
    if (m.kind === 'image') { c.duration = c.out = S.t - it.start; b.duration = b.out = it.dur - c.duration; }
    else { const src = c.in + (S.t - it.start) * c.speed; b.in = src; c.out = src; }
    S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
    S.sel = { type: 'clip', uid: b.uid };
    refreshAll();
}
function duplicateSel() {
    const c = selClip(), t = selText();
    if (c) { commit(); const d = { ...c, uid: uid(), crop: c.crop && { ...c.crop } }; S.clips.splice(S.clips.indexOf(c) + 1, 0, d); S.sel = { type: 'clip', uid: d.uid }; refreshAll(); }
    else if (t) { commit(); const d = { ...t, uid: uid(), start: t.start + t.dur }; delete d.imageId; S.texts.push(d); S.sel = { type: 'text', uid: d.uid }; refreshAll(); }
}
function deleteSel() {
    if (!S.sel) return;
    commit();
    if (S.sel.type === 'clip') S.clips = S.clips.filter(c => c.uid !== S.sel.uid);
    else if (S.sel.type === 'text') S.texts = S.texts.filter(t => t.uid !== S.sel.uid);
    else if (S.sel.type === 'music') S.music = null;
    S.sel = null; S.cropMode = false;
    refreshAll();
}
function addText(text = 'Your text', start = S.t, dur = 3) {
    const t = { uid: uid(), text, start, dur, size: 6, color: '#ffffff', pos: 'bottom', box: true, bold: true };
    S.texts.push(t);
    return t;
}

// ---------------------------------------------------------------- properties panel
const row = (label, ...inputs) => el('div', { class: 'field' }, el('label', {}, label), ...inputs);

function slider(label, min, max, step, value, fmtFn, onInput) {
    const out = el('span', {}, fmtFn(value));
    const input = el('input', { type: 'range', min, max, step, value });
    input.addEventListener('pointerdown', () => commit());
    input.addEventListener('input', () => { out.textContent = fmtFn(+input.value); onInput(+input.value); });
    return el('div', { class: 'field' }, el('label', {}, el('span', {}, label), out), input);
}
function numberBox(label, value, min, max, step, onChange) {
    const input = el('input', { type: 'number', min, max, step, value: Number(value).toFixed(2) });
    input.addEventListener('change', () => { commit(); onChange(clamp(parseFloat(input.value) || 0, min, max)); });
    return el('div', {}, el('label', { class: 'lbl' }, label), input);
}

function renderProps() {
    const p = $('#props');
    p.replaceChildren();
    const c = selClip(), t = selText();

    if (c) {
        const m = mediaOf(c);
        p.append(el('div', { class: 'props-title' }, m.kind === 'image' ? 'Photo' : 'Video clip', el('small', {}, fmt(clipDur(c)))));
        if (m.kind === 'video') {
            p.append(slider('Speed', 0.25, 4, 0.05, c.speed, v => v.toFixed(2) + '×', v => { c.speed = v; renderTimeline(); showAt(S.t, true); }));
            const chips = el('div', { class: 'chips' });
            for (const v of [0.5, 1, 1.5, 2, 4]) chips.append(el('button', { class: c.speed === v ? 'on' : '', onclick: () => { commit(); c.speed = v; refreshAll(); } }, v + '×'));
            p.lastChild.append(chips);
            p.append(el('div', { class: 'field' }, el('label', {}, 'Trim (seconds in the original)'), el('div', { class: 'kv' },
                numberBox('Start', c.in, 0, m.duration, 0.1, v => { c.in = Math.min(v, c.out - 0.1); refreshAll(); }),
                numberBox('End', c.out, 0, m.duration, 0.1, v => { c.out = Math.max(v, c.in + 0.1); refreshAll(); }))));
            p.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: c.mute, onchange: ev => { commit(); c.mute = ev.target.checked; refreshAll(); } }),
                m.acodec ? 'Cut the voice (mute this clip)' : 'This clip has no sound'));
            if (m.acodec) p.append(slider('Clip volume', 0, 2, 0.05, c.volume, v => Math.round(v * 100) + '%', v => { c.volume = v; showAt(S.t, false); }));
        } else {
            p.append(el('div', { class: 'field' }, numberBox('Show for (seconds)', c.duration, 0.2, 600, 0.5, v => { c.duration = c.out = v; refreshAll(); })));
        }
        p.append(cropControls(c, m));
        const acts = el('div', { class: 'actions' });
        if (m.kind === 'video') acts.append(el('button', { onclick: splitAtPlayhead }, '✂ Split at playhead'));
        acts.append(el('button', { onclick: () => exportImage(c) }, m.kind === 'image' ? 'Export picture' : 'Save frame as picture'));
        acts.append(el('button', { class: 'danger', onclick: deleteSel }, 'Delete'));
        p.append(acts);
    } else if (t) {
        p.append(el('div', { class: 'props-title' }, 'Text'));
        const ta = el('textarea', { value: t.text });
        ta.addEventListener('focus', () => commit(), { once: true });
        ta.addEventListener('input', () => { t.text = ta.value; renderTimeline(); showAt(S.t, true); });
        ta.addEventListener('blur', () => ta.addEventListener('focus', () => commit(), { once: true }));
        p.append(el('div', { class: 'field' }, el('label', {}, 'Words'), ta));
        p.append(slider('Size', 2, 20, 0.5, t.size, v => v.toFixed(1) + '%', v => { t.size = v; showAt(S.t, true); }));
        const color = el('input', { type: 'color', value: t.color });
        color.addEventListener('input', () => { t.color = color.value; showAt(S.t, true); });
        const pos = el('select', { onchange: ev => { commit(); t.pos = ev.target.value; showAt(S.t, true); } },
            ...[['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']].map(([v, l]) => el('option', { value: v, selected: t.pos === v }, l)));
        pos.value = t.pos;
        p.append(el('div', { class: 'kv field' }, el('div', {}, el('label', { class: 'lbl' }, 'Colour'), color), el('div', {}, el('label', { class: 'lbl' }, 'Position'), pos)));
        p.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: t.box, onchange: ev => { commit(); t.box = ev.target.checked; showAt(S.t, true); } }), 'Dark box behind text'));
        p.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: t.bold, onchange: ev => { commit(); t.bold = ev.target.checked; showAt(S.t, true); } }), 'Bold'));
        p.append(el('div', { class: 'field' }, el('div', { class: 'kv' },
            numberBox('Starts at (s)', t.start, 0, 36000, 0.1, v => { t.start = v; refreshAll(); }),
            numberBox('Lasts (s)', t.dur, 0.2, 36000, 0.1, v => { t.dur = v; refreshAll(); }))));
        p.append(el('div', { class: 'actions' }, el('button', { onclick: duplicateSel }, 'Duplicate'), el('button', { class: 'danger', onclick: deleteSel }, 'Delete')));
    } else if (S.sel && S.sel.type === 'music' && S.music) {
        const m = S.media.get(S.music.mediaId);
        p.append(el('div', { class: 'props-title' }, '♪ Music', el('small', {}, m.name)));
        p.append(slider('Music volume', 0, 2, 0.05, S.music.volume, v => Math.round(v * 100) + '%', v => { S.music.volume = v; mus.volume = clamp(v, 0, 1); }));
        p.append(slider('Original sound', 0, 2, 0.05, S.music.orig, v => Math.round(v * 100) + '%', v => { S.music.orig = v; }));
        const mode = el('select', { onchange: ev => { commit(); S.music.mode = ev.target.value; showAt(S.t, true); } },
            el('option', { value: 'mix' }, 'Play together with the original sound'),
            el('option', { value: 'replace' }, 'Replace the original sound'));
        mode.value = S.music.mode;
        p.append(el('div', { class: 'field' }, el('label', {}, 'Mode'), mode));
        p.append(el('div', { class: 'hint', style: 'padding-left:0' }, 'The music loops to fit the video and fades out over the last 1.5 seconds.'));
        p.append(el('div', { class: 'actions' }, el('button', { class: 'danger', onclick: deleteSel }, 'Remove music')));
    } else {
        p.append(el('div', { class: 'props-title' }, 'Getting started'));
        p.append(el('div', { class: 'hint', style: 'padding-left:0' },
            'Click a clip, caption or the music bar to edit it.',
            el('br'), el('br'), '• Drag clips on the timeline to reorder them.',
            el('br'), '• Drag a clip’s edges to trim it.',
            el('br'), '• Press S to split at the playhead.',
            el('br'), '• Cuts, joins, muting and music are instant: the original video is copied, not re-rendered.',
            el('br'), '• Speed, crop and text need a short re-render, done on your graphics hardware when available.'));
    }
}

// ---------------------------------------------------------------- crop tool
function cropControls(c, m) {
    const box = el('div', { class: 'field' });
    const on = S.cropMode;
    box.append(el('label', {}, el('span', {}, 'Crop'), el('span', {}, c.crop ? `${Math.round(c.crop.w * m.width)}×${Math.round(c.crop.h * m.height)}` : 'None')));
    const acts = el('div', { class: 'actions', style: 'margin:0' });
    acts.append(el('button', { class: on ? 'accent' : '', onclick: () => toggleCrop(c) }, on ? 'Done cropping' : 'Crop…'));
    if (c.crop) acts.append(el('button', { onclick: () => { commit(); c.crop = null; S.cropLock = null; refreshAll(); } }, 'Reset'));
    box.append(acts);
    if (on) {
        const sel = el('select', { onchange: ev => setCropRatio(c, m, ev.target.value) },
            ...[['free', 'Free'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['4:3', '4:3']].map(([v, l]) => el('option', { value: v }, l)));
        sel.value = S.cropLock || 'free';
        box.append(el('div', { class: 'chips' }, el('label', { class: 'muted' }, 'Shape '), sel));
    }
    return box;
}
function toggleCrop(c) {
    S.cropMode = !S.cropMode;
    if (S.cropMode) {
        commit();
        const it = layout().items.find(i => i.c === c);
        if (S.t < it.start || S.t >= it.start + it.dur) S.t = it.start;
        if (!c.crop) c.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    } else if (c.crop && c.crop.w > 0.999 && c.crop.h > 0.999) c.crop = null;
    refreshAll();
}
function setCropRatio(c, m, v) {
    S.cropLock = v === 'free' ? null : v;
    if (!S.cropLock) return;
    const [a, b] = v.split(':').map(Number);
    const r = (a / b) * (m.height / m.width); // normalised w/h
    let w = 1, h = w / r;
    if (h > 1) { h = 1; w = h * r; }
    c.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
    refreshAll();
}
function positionCropEl(cr) {
    Object.assign($('#crop').style, { left: cr.x * 100 + '%', top: cr.y * 100 + '%', width: cr.w * 100 + '%', height: cr.h * 100 + '%' });
}
$('#crop').addEventListener('pointerdown', e => {
    const c = selClip();
    if (!c || !c.crop) return;
    const m = mediaOf(c);
    const handle = e.target.dataset && e.target.dataset.h;
    const rect = $('#clipbox').getBoundingClientRect();
    const o = { ...c.crop };
    const ratio = S.cropLock ? (() => { const [a, b] = S.cropLock.split(':').map(Number); return (a / b) * (m.height / m.width); })() : null;
    dragPointer(e, (dx, dy) => {
        const ux = dx / rect.width, uy = dy / rect.height;
        let { x, y, w, h } = o;
        if (!handle) {
            x = clamp(o.x + ux, 0, 1 - o.w); y = clamp(o.y + uy, 0, 1 - o.h);
        } else {
            let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
            if (handle.includes('w')) x1 = clamp(x1 + ux, 0, x2 - 0.05);
            if (handle.includes('e')) x2 = clamp(x2 + ux, x1 + 0.05, 1);
            if (handle.includes('n')) y1 = clamp(y1 + uy, 0, y2 - 0.05);
            if (handle.includes('s')) y2 = clamp(y2 + uy, y1 + 0.05, 1);
            w = x2 - x1; h = y2 - y1;
            if (ratio) {
                const horizontalOnly = !handle.includes('n') && !handle.includes('s');
                if (horizontalOnly) { h = w / ratio; } else { w = h * ratio; }
                if (handle.includes('w')) x1 = x2 - w; else if (handle.includes('e') || horizontalOnly) x2 = x1 + w;
                if (handle.includes('n')) y1 = y2 - h; else if (handle.includes('s')) y2 = y1 + h;
                else { const cy = (o.y + o.h / 2); y1 = cy - h / 2; y2 = cy + h / 2; }
                if (x1 < 0) { x1 = 0; w = x2 - x1; h = w / ratio; }
                if (x2 > 1) { x2 = 1; w = x2 - x1; h = w / ratio; }
                if (y1 < 0 || y2 > 1) { h = Math.min(h, Math.min(1, y2) - Math.max(0, y1)); w = h * ratio; }
                if (handle.includes('w')) x1 = x2 - w; else x2 = x1 + w;
                if (handle.includes('n')) y1 = y2 - h; else y2 = y1 + h;
                y1 = clamp(y1, 0, 1 - h); y2 = y1 + h;
            }
            x = x1; y = y1; w = x2 - x1; h = y2 - y1;
        }
        c.crop = { x, y, w, h };
        positionCropEl(c.crop);
    }, () => { renderTimeline(); renderProps(); });
});

// ---------------------------------------------------------------- captions import
function parseSrt(text) {
    const toSec = s => { const [h, m, rest] = s.trim().replace(',', '.').split(':'); return (+h) * 3600 + (+m) * 60 + parseFloat(rest); };
    const out = [];
    for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
        const lines = block.split('\n').filter(l => l.trim() !== '');
        const i = lines.findIndex(l => l.includes('-->'));
        if (i < 0) continue;
        const [a, b] = lines[i].split('-->');
        const words = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '');
        if (words.trim()) out.push({ text: words, start: toSec(a), end: toSec(b.split(' ')[0]) });
    }
    return out;
}

// ---------------------------------------------------------------- export
async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
}
function clipPayload(c) {
    return { mediaId: c.mediaId, in: c.in, out: c.out, speed: c.speed, crop: c.crop, mute: c.mute, volume: c.volume, duration: c.duration };
}
async function runJob(payload, onProgress) {
    const { jobId } = await post('/api/export', payload);
    for (;;) {
        const j = await (await fetch('/api/job/' + jobId)).json();
        if (j.status === 'done') return j.result;
        if (j.status === 'error') throw new Error(j.error);
        onProgress && onProgress(j.progress);
        await new Promise(r => setTimeout(r, 120));
    }
}
async function captionImages() {
    // Make sure every caption has an up-to-date PNG on the server.
    for (const t of S.texts) {
        if (!String(t.text).trim()) continue;
        const key = textKey(t);
        if (t.imageId && t.imageKey === key) continue;
        const blob = await new Promise(r => textCanvas(t).toBlob(r, 'image/png'));
        const m = await uploadFile(blob, 'caption.png');
        S.media.set(m.id, m);
        t.imageId = m.id; t.imageKey = key;
    }
}
function download(url) { const a = el('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); }

async function exportImage(c) {
    const it = layout().items.find(i => i.c === c);
    const inClip = S.t >= it.start && S.t < it.start + it.dur;
    const m = mediaOf(c);
    const frameAt = m.kind === 'video' ? c.in + ((inClip ? S.t : it.start) - it.start) * c.speed : 0;
    const t = toast('Saving picture…', { sticky: true });
    try {
        const r = await runJob({ format: 'image', frameAt, clips: [clipPayload(c)] });
        download('/api/download/' + r.id);
        toast(`Saved ${r.name}`);
    } catch (e) { toast(e.message, { err: true, ms: 7000 }); }
    t.remove();
}

function openExport() {
    const L = layout();
    if (!L.items.length) return toast('Add a clip to the timeline first.');
    const dlg = $('#exportDlg');
    const state = { keep: 'av', quality: 'fast' };
    const body = el('div');
    const keep = el('select', { onchange: ev => (state.keep = ev.target.value) },
        el('option', { value: 'av' }, 'Video with voice'),
        el('option', { value: 'v' }, 'Video only (cut the voice)'),
        el('option', { value: 'a' }, 'Voice only (cut the video, save as audio)'));
    const quality = el('select', { onchange: ev => (state.quality = ev.target.value) },
        el('option', { value: 'fast' }, 'Fast: up to 1080p (recommended)'),
        el('option', { value: 'original' }, 'Original size (slower, bigger file)'));
    const fast = el('input', { type: 'checkbox', checked: S.exp.fast, onchange: ev => (S.exp.fast = ev.target.checked) });
    const bar = el('i'), status = el('div', { class: 'muted' }), result = el('div');
    const go = el('button', { class: 'primary' }, 'Export');
    const close = el('button', { onclick: () => dlg.close() }, 'Close');
    go.onclick = async () => {
        go.disabled = true; result.replaceChildren(); status.textContent = 'Preparing…'; bar.style.width = '3%';
        try {
            await captionImages();
            const started = Date.now();
            const r = await runJob({
                clips: S.clips.map(clipPayload),
                texts: S.texts.filter(t => t.imageId && String(t.text).trim()).map(t => ({ imageId: t.imageId, start: t.start, dur: t.dur, pos: t.pos })),
                music: S.music, keep: state.keep, quality: state.quality, size: S.exp.size, fast: S.exp.fast,
            }, p => {
                bar.style.width = Math.max(3, p * 100) + '%';
                const el_s = (Date.now() - started) / 1000;
                const eta = p > 0.05 ? Math.max(0, el_s / p - el_s) : null;
                status.textContent = `Exporting… ${Math.round(p * 100)}%` + (eta !== null ? ` · about ${Math.ceil(eta)} s left` : '');
            });
            bar.style.width = '100%';
            status.textContent = '';
            result.append(el('div', { class: 'done-box' },
                el('b', {}, `Finished in ${r.seconds.toFixed(r.seconds < 10 ? 2 : 1)} s`),
                el('br'),
                r.mode === 'instant' ? 'Instant: original quality, nothing was re-rendered.' : `Rendered with ${r.encoder === 'libx264' ? 'the CPU' : r.encoder}.`,
                el('span', { class: 'muted' }, `  ${(r.size / 1048576).toFixed(1)} MB`),
                el('br'), el('a', { href: '/api/download/' + r.id, download: r.name }, 'Download ' + r.name)));
        } catch (e) { status.textContent = ''; bar.style.width = '0'; result.append(el('div', { class: 'toast err' }, e.message)); }
        go.disabled = false;
    };
    body.append(el('h3', {}, 'Export'),
        el('div', { class: 'field' }, el('label', {}, 'What to keep'), keep),
        el('div', { class: 'field' }, el('label', {}, 'Quality'), quality),
        el('label', { class: 'check' }, fast, 'Instant mode: copy the original video whenever nothing needs re-rendering'),
        el('div', { class: 'bar' }, bar), status, result,
        el('div', { class: 'actions', style: 'margin-top:16px;justify-content:flex-end' }, close, go));
    dlg.replaceChildren(body);
    dlg.showModal();
}

// ---------------------------------------------------------------- wiring
function refreshAll() {
    renderBin(); renderTimeline(); renderProps(); showAt(S.t, true);
}

$('#importBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
$('#addText').onclick = () => { commit(); const t = addText(); S.sel = { type: 'text', uid: t.uid }; refreshAll(); };
$('#importSrt').onclick = () => $('#srtInput').click();
$('#srtInput').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const items = parseSrt(await f.text());
    if (!items.length) return toast('No captions found in that file.', { err: true });
    commit();
    for (const i of items) addText(i.text, i.start, Math.max(0.2, i.end - i.start));
    refreshAll();
    toast(`Added ${items.length} captions.`);
};
$('#play').onclick = () => (S.playing ? pause() : play());
$('#toStart').onclick = () => seek(0);
$('#split').onclick = splitAtPlayhead;
$('#dup').onclick = duplicateSel;
$('#del').onclick = deleteSel;
$('#undoBtn').onclick = undo;
$('#redoBtn').onclick = redo;
$('#exportBtn').onclick = openExport;
$('#zoom').oninput = e => { S.zoom = +e.target.value; renderTimeline(); };
$('#sizeSel').onchange = e => { S.exp.size = e.target.value; showAt(S.t, true); };

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); });
window.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range') return;
    if ($('#exportDlg').open) return;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    else if (e.key === 's' && !e.ctrlKey && !e.metaKey) splitAtPlayhead();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'ArrowLeft') seek(S.t - (e.shiftKey ? 1 : 0.1));
    else if (e.key === 'ArrowRight') seek(S.t + (e.shiftKey ? 1 : 0.1));
});
new ResizeObserver(() => showAt(S.t, false)).observe($('#stage'));
fetch('/api/info').then(r => r.json()).then(i => ($('#hw').textContent = i.encoder === 'libx264' ? 'Renders on CPU' : 'Hardware encoding: ' + i.encoder));

setInterval(() => fetch('/api/hb').catch(() => {}), 5000);
fetch('/api/hb').catch(() => {});
window.addEventListener('pagehide', () => navigator.sendBeacon('/api/bye'));

refreshAll();
window.__clipcut = { S, addToTimeline, importFiles };
