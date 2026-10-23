const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const ff = require('./lib/ff');
const { plan } = require('./lib/export');

const PORT = Number(process.env.PORT) || 3002;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcut-'));
const media = new Map();   // id -> { file, name, kind, duration, width, height, ... }
const outputs = new Map(); // id -> { file, name }
const jobs = new Map();    // id -> { status, progress, result, error }

const newId = () => crypto.randomBytes(8).toString('hex');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Raw body streamed straight to disk: no multipart parsing, no buffering of big videos.
app.post('/api/upload', async (req, res) => {
    const id = newId();
    const name = String(req.query.name || id);
    const ext = path.extname(name).toLowerCase().replace(/[^.\w]/g, '').slice(0, 8);
    const file = path.join(WORK_DIR, id + ext);
    try {
        await pipeline(req, fs.createWriteStream(file));
        const info = await ff.probe(file, ext);
        media.set(id, { id, file, name, ...info });
        if (info.kind !== 'audio') {
            const at = info.kind === 'video' ? Math.min(1, info.duration / 2) : 0;
            await ff.run(['-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=-2:90', path.join(WORK_DIR, id + '.jpg')]).catch(() => {});
        }
        res.json({ id, name, ...info });
    } catch (err) {
        fs.rm(file, { force: true }, () => {});
        res.status(400).json({ error: 'That file could not be read as video, audio or an image.' });
    }
});

const known = (req, res, map) => {
    const m = map.get(req.params.id);
    if (!m) res.sendStatus(404);
    return m;
};
app.get('/api/media/:id', (req, res) => { const m = known(req, res, media); if (m) res.sendFile(m.file); }); // Range-aware
app.get('/api/thumb/:id', (req, res) => {
    if (!media.has(req.params.id)) return res.sendStatus(404);
    res.sendFile(path.join(WORK_DIR, req.params.id + '.jpg'), err => err && !res.headersSent && res.sendStatus(404));
});

app.post('/api/export', async (req, res) => {
    const jobId = newId();
    const job = { status: 'running', progress: 0 };
    jobs.set(jobId, job);
    res.json({ jobId });

    const t0 = Date.now();
    try {
        const ctx = { workDir: WORK_DIR, id: jobId };
        const p = await plan(req.body, media, ctx, ff.pickEncoder);
        const outId = newId();
        const out = path.join(WORK_DIR, `${outId}.${p.ext}`);
        await ff.run([...p.args, out], p.total, pr => (job.progress = pr));
        const first = media.get((req.body.clips || [])[0]?.mediaId);
        const base = first ? path.parse(first.name).name : 'clipcut';
        const name = `${base}-edit.${p.ext}`;
        outputs.set(outId, { file: out, name });
        Object.assign(job, {
            status: 'done', progress: 1,
            result: { id: outId, name, mode: p.mode, encoder: p.encoder, seconds: (Date.now() - t0) / 1000, size: fs.statSync(out).size, ext: p.ext },
        });
    } catch (err) {
        console.error(err.message);
        Object.assign(job, { status: 'error', error: err.message });
    }
});

app.get('/api/job/:id', (req, res) => { const j = known(req, res, jobs); if (j) res.json(j); });
app.get('/api/download/:id', (req, res) => { const o = known(req, res, outputs); if (o) res.download(o.file, o.name); });
app.get('/api/info', async (req, res) => res.json({ encoder: (await ff.pickEncoder()).name }));

const cleanup = () => fs.rmSync(WORK_DIR, { recursive: true, force: true });
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const server = app.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`ClipCut is running at ${url}`);
    ff.pickEncoder().then(e => console.log(`Export encoder: ${e.name}`));
    if (!process.env.NO_OPEN) {
        const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
});
server.keepAliveTimeout = 65000; // reused sockets must outlive slow edits; the 5s default resets uploads
