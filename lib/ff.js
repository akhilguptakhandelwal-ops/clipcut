const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Order: ffmpeg shipped next to the installed app, then the npm-bundled one, then PATH.
function resolveBin(name) {
    const exe = name + (process.platform === 'win32' ? '.exe' : '');
    const beside = path.join(path.dirname(process.execPath), exe);
    if (process.pkg && fs.existsSync(beside)) return beside;
    try {
        if (name === 'ffmpeg') return require('ffmpeg-static') || 'ffmpeg';
        return require('ffprobe-static').path || 'ffprobe';
    } catch (e) {
        return name;
    }
}
const FFMPEG = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

const fps = r => {
    const [a, b] = String(r || '0/1').split('/').map(Number);
    return b ? a / b : a || 0;
};

function probe(file, ext) {
    return new Promise((resolve, reject) => {
        execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
            { maxBuffer: 16 * 1024 * 1024 },
            (err, out) => {
                if (err) return reject(err);
                const info = JSON.parse(out);
                const v = info.streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
                const a = info.streams.find(s => s.codec_type === 'audio');
                if (!v && !a) return reject(new Error('no media streams'));
                const isImage = !!v && (IMAGE_EXT.has(ext) || /image2|_pipe/.test(info.format.format_name));
                let rotation = 0;
                if (v) {
                    const sd = (v.side_data_list || []).find(s => s.rotation !== undefined);
                    rotation = Math.abs(Number(sd ? sd.rotation : v.tags && v.tags.rotate) || 0) % 180;
                }
                const w = v ? v.width : 0, h = v ? v.height : 0;
                resolve({
                    kind: isImage ? 'image' : v ? 'video' : 'audio',
                    duration: isImage ? 0 : parseFloat(info.format.duration) || 0,
                    // display size = after the player's auto-rotation
                    width: rotation === 90 ? h : w,
                    height: rotation === 90 ? w : h,
                    vcodec: v && v.codec_name,
                    pixFmt: v && v.pix_fmt,
                    fps: v ? fps(v.r_frame_rate) : 0,
                    acodec: a && a.codec_name,
                    sampleRate: a && Number(a.sample_rate),
                    channels: a && a.channels,
                });
            });
    });
}

// Hardware H.264 encoders turn crop/text/speed renders from minutes into seconds.
// Each candidate is test-encoded once, because "listed" does not mean "works on this laptop".
const ENCODERS = [
    { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p2', '-cq', '24', '-b:v', '0'] },
    { name: 'h264_videotoolbox', args: ['-c:v', 'h264_videotoolbox', '-q:v', '65'] },
    { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-global_quality', '23', '-preset', 'veryfast'] },
    { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'] },
];
const SOFTWARE = { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21'] };

function works(enc) {
    return new Promise(resolve => {
        execFile(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-pix_fmt', 'yuv420p',
            ...enc.args, '-f', 'null', '-'], { timeout: 15000 }, err => resolve(!err));
    });
}

let encoderPromise;
function pickEncoder() {
    if (!encoderPromise) {
        encoderPromise = (async () => {
            for (const enc of ENCODERS) if (await works(enc)) return enc;
            return SOFTWARE;
        })();
    }
    return encoderPromise;
}

// Runs ffmpeg, reporting 0..1 progress against `total` seconds of output.
function run(args, total, onProgress) {
    return new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args]);
        let err = '';
        ff.stdout.on('data', d => {
            const m = String(d).match(/out_time_us=(\d+)/g);
            if (m && total > 0 && onProgress) {
                const us = Number(m[m.length - 1].split('=')[1]);
                onProgress(Math.min(0.99, us / 1e6 / total));
            }
        });
        ff.stderr.on('data', d => (err += d));
        ff.on('error', reject);
        ff.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-2).join(' ') || 'ffmpeg failed'))));
    });
}

module.exports = { FFMPEG, probe, pickEncoder, run, fs };
