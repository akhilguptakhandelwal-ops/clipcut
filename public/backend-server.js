// Laptop backend: talks to the local ClipCut server (native ffmpeg, GPU encoders).
window.ClipCutBackend = {
    saveLabel: 'Download',

    importFile(file, onProgress, nameOverride) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open('POST', '/api/upload?name=' + encodeURIComponent(nameOverride || file.name));
            x.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
            x.onload = () => {
                let j = {};
                try { j = JSON.parse(x.responseText); } catch (e) { /* non-JSON error page */ }
                x.status === 200 ? resolve(j) : reject(new Error(j.error || 'Upload failed'));
            };
            x.onerror = () => reject(new Error('Upload failed'));
            x.send(file);
        });
    },

    mediaUrl: m => '/api/media/' + m.id,
    thumbUrl: m => '/api/thumb/' + m.id,

    async runExport(payload, onProgress) {
        const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const { jobId } = await r.json();
        for (;;) {
            const j = await (await fetch('/api/job/' + jobId)).json();
            if (j.status === 'done') return j.result;
            if (j.status === 'error') throw new Error(j.error);
            onProgress && onProgress(j.progress);
            await new Promise(res => setTimeout(res, 120));
        }
    },

    async save(result) {
        const a = document.createElement('a');
        a.href = '/api/download/' + result.id; a.download = result.name;
        document.body.append(a); a.click(); a.remove();
    },

    async info() {
        const i = await (await fetch('/api/info')).json();
        return i.encoder === 'libx264' ? 'Renders on CPU' : 'Hardware encoding: ' + i.encoder;
    },

    // The installed app quits when its window closes: heartbeat while open, goodbye on close.
    start() {
        setInterval(() => fetch('/api/hb').catch(() => {}), 5000);
        fetch('/api/hb').catch(() => {});
        window.addEventListener('pagehide', () => navigator.sendBeacon('/api/bye'));
    },
};
