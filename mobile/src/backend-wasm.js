// Phone backend: ffmpeg runs inside the app (WebAssembly). No server, no internet, nothing leaves the phone.
(function () {
    const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|heic)$/i;
    const media = new Map();      // id -> meta used by the planner (plus blob + preview url)
    const outputs = new Map();    // id -> { blob, name }
    let ffmpeg = null, ready = null, logSink = null, progressCb = null, totalForProgress = 0;
    let chain = Promise.resolve();
    const exclusive = fn => (chain = chain.then(fn, fn)); // ffmpeg.wasm runs one command at a time
    const newId = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16);
    const rel = p => new URL(p, document.baseURI).href;

    function load() {
        if (ready) return ready;
        ready = (async () => {
            ffmpeg = new FFmpegWASM.FFmpeg();
            ffmpeg.on('log', ({ message }) => logSink && logSink.push(message));
            ffmpeg.on('progress', ({ time }) => progressCb && totalForProgress > 0 && progressCb(Math.min(0.99, time / 1e6 / totalForProgress)));
            await ffmpeg.load({
                coreURL: rel('vendor/ffmpeg-core.js'),
                wasmURL: rel('vendor/ffmpeg-core.wasm'),
            });
            await ffmpeg.createDir('/work');
        })();
        return ready;
    }

    async function run(args, total, onProgress) {
        logSink = [];
        progressCb = onProgress; totalForProgress = total;
        try {
            const code = await ffmpeg.exec(args, -1);
            if (code !== 0) throw new Error(logSink.filter(l => /error|invalid|unable|no such|not found|fail/i.test(l)).slice(-2).join(' ') || 'ffmpeg failed');
        } finally { progressCb = null; }
    }

    // ffmpeg.wasm has no ffprobe, so read the stream info ffmpeg prints for `-i file`.
    async function probe(path, name) {
        logSink = [];
        await ffmpeg.exec(['-hide_banner', '-i', path], -1).catch(() => {});
        const log = logSink.join('\n');
        logSink = null;
        const dur = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
        const duration = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0;
        const vline = (log.split('\n').find(l => /Stream #.*Video:/.test(l) && !/attached pic/.test(l))) || '';
        const aline = (log.split('\n').find(l => /Stream #.*Audio:/.test(l))) || '';
        if (!vline && !aline) throw new Error('That file could not be read as video, audio or an image.');
        const size = vline.match(/\b(\d{2,5})x(\d{2,5})\b/);
        const rot = Math.abs(parseFloat((log.match(/rotation of (-?[\d.]+) degrees/) || [])[1]) || 0) % 180;
        let w = size ? +size[1] : 0, h = size ? +size[2] : 0;
        if (rot === 90) [w, h] = [h, w];
        const vcodec = (vline.match(/Video: (\w+)/) || [])[1];
        const ch = (aline.match(/Hz, ([^,]+),/) || [])[1] || '';
        const isImage = !!vline && (IMAGE_EXT.test(name) || (/^(png|mjpeg|webp|bmp|gif)$/.test(vcodec) && !duration));
        return {
            kind: isImage ? 'image' : vline ? 'video' : 'audio',
            duration: isImage ? 0 : duration,
            width: w, height: h, vcodec,
            pixFmt: (vline.match(/, (yuv\w*|nv\d+|gbr\w*|rgb\w*|bgr\w*|gray\w*|pal8)/) || [])[1],
            fps: parseFloat((vline.match(/([\d.]+) fps/) || [])[1]) || 0,
            acodec: (aline.match(/Audio: (\w+)/) || [])[1],
            sampleRate: +((aline.match(/(\d+) Hz/) || [])[1]) || undefined,
            channels: /mono/.test(ch) ? 1 : /stereo/.test(ch) ? 2 : parseInt(ch) || undefined,
        };
    }

    async function thumbnail(m) {
        if (m.kind === 'audio') return 'data:,';
        const out = `/work/th_${m.id}.jpg`;
        try {
            await run(['-ss', String(m.kind === 'video' ? Math.min(1, m.duration / 2) : 0), '-i', m.file, '-frames:v', '1', '-vf', 'scale=-2:90', '-q:v', '6', out], 0);
            const data = await ffmpeg.readFile(out);
            await ffmpeg.deleteFile(out);
            return URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
        } catch (e) { return 'data:,'; }
    }

    async function toBase64(blob) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result).split(',')[1]);
            r.onerror = rej;
            r.readAsDataURL(blob);
        });
    }

    window.ClipCutBackend = {
        saveLabel: 'Save / share',

        start() {
            const t = document.createElement('div');
            t.className = 'toast'; t.textContent = 'Preparing the editor…';
            document.getElementById('toasts').append(t);
            load().then(() => t.remove(), e => { console.error('ffmpeg load failed', e); t.textContent = 'Could not start ffmpeg: ' + (e && e.message || e); t.classList.add('err'); });
        },

        importFile(file, onProgress, nameOverride) {
            return exclusive(async () => {
                await load();
                const name = nameOverride || file.name || 'file';
                const id = newId();
                const ext = (name.match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0].toLowerCase();
                const dir = `/m_${id}`;
                await ffmpeg.createDir(dir);
                await ffmpeg.mount('WORKERFS', { blobs: [{ name: 'file' + ext, data: file }] }, dir); // read lazily, never copied into memory
                const path = `${dir}/file${ext}`;
                let meta;
                try { meta = await probe(path, name); } catch (e) { await ffmpeg.unmount(dir).catch(() => {}); throw e; }
                const m = { id, name, file: path, ...meta, blob: file, url: URL.createObjectURL(file) };
                media.set(id, m);
                m.thumb = await thumbnail(m);
                onProgress && onProgress(1);
                const { blob, url, thumb, ...plain } = m;
                return plain;
            });
        },

        mediaUrl: m => media.get(m.id).url,
        thumbUrl: m => (media.get(m.id) || {}).thumb || 'data:,',

        runExport(payload, onProgress) {
            return exclusive(async () => {
                await load();
                const t0 = Date.now();
                const id = newId();
                const ctx = { workDir: '/work', id, hwDecode: false, writeFile: (p, text) => ffmpeg.writeFile(p, text) };
                const enc = async () => ({ name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25'] });
                const p = await ClipCutPlanner.plan({ ...payload, maxShort: payload.maxShort || 720 }, media, ctx, enc);
                const out = `/work/${id}.${p.ext}`;
                await run([...p.args, out], p.total, onProgress);
                const data = await ffmpeg.readFile(out);
                await ffmpeg.deleteFile(out).catch(() => {});
                const first = media.get((payload.clips || [])[0] && payload.clips[0].mediaId);
                const base = first ? first.name.replace(/\.[^.]+$/, '') : 'clipcut';
                const name = `${base}-edit.${p.ext}`;
                const mime = p.ext === 'png' ? 'image/png' : p.ext === 'm4a' ? 'audio/mp4' : p.ext === 'mkv' ? 'video/x-matroska' : 'video/mp4';
                outputs.set(id, { blob: new Blob([data], { type: mime }), name });
                return { id, name, mode: p.mode, encoder: p.encoder === 'libx264' ? 'the phone CPU' : p.encoder, seconds: (Date.now() - t0) / 1000, size: data.length, ext: p.ext };
            });
        },

        async save(result) {
            const o = outputs.get(result.id);
            const cap = window.Capacitor;
            if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
                // Android: write to the app cache in chunks (keeps memory low), then open the share sheet
                // so the person can save to Gallery / Files / Drive or send it on WhatsApp.
                const { Filesystem, Share } = cap.Plugins;
                const path = `export_${Date.now()}_${o.name}`;
                const CHUNK = 3 * 1024 * 1024;
                for (let off = 0; off < o.blob.size; off += CHUNK) {
                    const data = await toBase64(o.blob.slice(off, off + CHUNK));
                    if (off === 0) await Filesystem.writeFile({ path, data, directory: 'CACHE' });
                    else await Filesystem.appendFile({ path, data, directory: 'CACHE' });
                }
                const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
                await Share.share({ title: o.name, files: [uri] });
                return;
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(o.blob); a.download = o.name;
            document.body.append(a); a.click(); a.remove();
        },

        async info() { return 'Phone mode · editing happens on this device'; },
    };
})();
