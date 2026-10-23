// End-to-end check of every export path. Needs ffmpeg; generates its own sample media.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const ff = require('../lib/ff');

const PORT = 3999;
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcut-test-'));
const gen = (name, args) => { execFileSync(ff.FFMPEG, ['-y', '-v', 'error', ...args, path.join(dir, name)]); return path.join(dir, name); };

const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const upload = async file => (await fetch(`${base}/api/upload?name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: fs.readFileSync(file) })).json();

async function exportProject(project) {
    const { jobId } = await post('/api/export', project);
    for (;;) {
        const j = await (await fetch(`${base}/api/job/${jobId}`)).json();
        if (j.status === 'done') return j.result;
        if (j.status === 'error') throw new Error(j.error);
        await new Promise(r => setTimeout(r, 100));
    }
}
async function inspect(result) {
    const buf = Buffer.from(await (await fetch(`${base}/api/download/${result.id}`)).arrayBuffer());
    const f = path.join(dir, `out-${result.id}.${result.ext}`);
    fs.writeFileSync(f, buf);
    const j = JSON.parse(execFileSync(ff.FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') === ff.FFMPEG ? 'ffprobe' : 'ffprobe',
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]));
    return {
        duration: parseFloat(j.format.duration),
        v: j.streams.find(s => s.codec_type === 'video'),
        a: j.streams.find(s => s.codec_type === 'audio'),
    };
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: expected ~${b}, got ${a}`);

(async () => {
    const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, NO_OPEN: '1' }, stdio: 'ignore' });
    try {
        for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/info'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

        const vid = (n, freq, size = '1280x720') => gen(n, ['-f', 'lavfi', '-i', `testsrc=duration=20:size=${size}:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=20`,
            '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
        const A = await upload(vid('a.mp4', 440));
        const B = await upload(vid('b.mp4', 660));
        const small = await upload(vid('small.mp4', 330, '640x360'));
        const music = await upload(gen('m.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=5']));
        const img = await upload(gen('p.png', ['-f', 'lavfi', '-i', 'color=c=orange:s=800x600', '-frames:v', '1']));
        assert.equal(A.kind, 'video'); assert.equal(music.kind, 'audio'); assert.equal(img.kind, 'image');

        const clip = (m, o = {}) => ({ mediaId: m.id, in: 0, out: m.duration, ...o });
        let r, o;

        r = await exportProject({ clips: [clip(A, { in: 4, out: 9 })] });
        assert.equal(r.mode, 'instant'); o = await inspect(r);
        near(o.duration, 5, 1.2, 'instant trim'); assert(o.v && o.a, 'instant keeps both');
        console.log(`ok  instant trim        ${r.seconds.toFixed(2)}s`);

        r = await exportProject({ clips: [clip(A, { in: 0, out: 5 }), clip(B, { in: 2, out: 6 })] });
        assert.equal(r.mode, 'instant'); o = await inspect(r);
        near(o.duration, 9, 1.5, 'instant join');
        console.log(`ok  instant join        ${r.seconds.toFixed(2)}s`);

        r = await exportProject({ clips: [clip(A, { in: 0, out: 6 })], keep: 'v' });
        o = await inspect(r); assert(o.v && !o.a, 'video only has no audio');
        console.log('ok  video only');

        r = await exportProject({ clips: [clip(A, { in: 0, out: 6 })], keep: 'a' });
        o = await inspect(r); assert(!o.v && o.a, 'voice only has no video'); assert.equal(r.ext, 'm4a');
        console.log('ok  voice only');

        r = await exportProject({ clips: [clip(A, { in: 0, out: 6 })], music: { mediaId: music.id, mode: 'mix', volume: 0.5 } });
        assert.equal(r.mode, 'instant'); o = await inspect(r);
        assert.equal(o.v.codec_name, 'h264'); near(o.duration, 6, 0.3, 'music mix'); assert(o.a);
        console.log(`ok  music mix (video copied) ${r.seconds.toFixed(2)}s`);

        r = await exportProject({ clips: [clip(A, { in: 0, out: 6 })], keep: 'v', music: { mediaId: music.id, mode: 'replace' } });
        o = await inspect(r); assert(o.v && o.a); near(o.duration, 6, 0.3, 'music only');
        console.log('ok  video + music only');

        r = await exportProject({ clips: [clip(A, { in: 0, out: 8, speed: 2 })] });
        assert.equal(r.mode, 'rendered'); o = await inspect(r); near(o.duration, 4, 0.4, 'speed 2x'); assert(o.a);
        console.log(`ok  speed 2x            ${r.seconds.toFixed(2)}s via ${r.encoder}`);

        r = await exportProject({ clips: [clip(A, { in: 0, out: 2, speed: 0.5 })] });
        o = await inspect(r); near(o.duration, 4, 0.4, 'speed 0.5x');
        console.log('ok  speed 0.5x');

        r = await exportProject({ clips: [clip(A, { in: 0, out: 3, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } })], size: 'source' });
        o = await inspect(r); assert.equal(o.v.width, 640); assert.equal(o.v.height, 720);
        console.log('ok  video crop (source size follows crop)');

        r = await exportProject({ clips: [clip(A, { in: 0, out: 3 }), clip(small, { in: 0, out: 3 })], size: '720p' });
        assert.equal(r.mode, 'rendered'); o = await inspect(r); assert.equal(o.v.width, 1280); near(o.duration, 6, 0.4, 'mixed sizes');
        console.log('ok  join clips of different size');

        const caption = await upload(gen('cap.png', ['-f', 'lavfi', '-i', 'color=c=red@0.6:s=600x120,format=rgba', '-frames:v', '1']));
        r = await exportProject({ clips: [clip(A, { in: 0, out: 4 })], texts: [{ imageId: caption.id, start: 1, dur: 2, pos: 'bottom' }] });
        assert.equal(r.mode, 'rendered'); o = await inspect(r); near(o.duration, 4, 0.4, 'text');
        console.log(`ok  text overlay        ${r.seconds.toFixed(2)}s`);

        r = await exportProject({ clips: [clip(A, { in: 0, out: 3 }), { mediaId: img.id, duration: 2 }], size: '1080p' });
        o = await inspect(r); near(o.duration, 5, 0.4, 'image clip'); assert(o.a);
        console.log('ok  image in timeline');

        r = await exportProject({ format: 'image', clips: [{ mediaId: img.id, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }] });
        assert.equal(r.ext, 'png'); o = await inspect(r); assert.equal(o.v.width, 400); assert.equal(o.v.height, 300);
        console.log('ok  image crop');

        r = await exportProject({ format: 'image', frameAt: 5, clips: [clip(A, { crop: { x: 0, y: 0, w: 1, h: 0.5 } })] });
        o = await inspect(r); assert.equal(o.v.height, 360);
        console.log('ok  video frame -> cropped image');

        console.log('\nAll checks passed.');
    } catch (e) {
        console.error('\nFAILED:', e.message, e.cause || '');
        process.exitCode = 1;
    } finally {
        server.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})();
