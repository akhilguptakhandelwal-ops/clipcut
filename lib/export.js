const fs = require('fs');
const path = require('path');

const SIZES = { '1080p': [1920, 1080], '720p': [1280, 720], vertical: [1080, 1920], square: [1080, 1080] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
const even = n => Math.max(2, Math.round(n / 2) * 2);
const f3 = n => Number(n).toFixed(3);

function atempoChain(speed) {
    const parts = [];
    while (speed > 2) { parts.push('atempo=2'); speed /= 2; }
    while (speed < 0.5) { parts.push('atempo=0.5'); speed /= 0.5; }
    parts.push(`atempo=${f3(speed)}`);
    return parts.join(',');
}

function cropOf(c) {
    if (!c) return null;
    const x = clamp(num(c.x, 0), 0, 0.98), y = clamp(num(c.y, 0), 0, 0.98);
    const w = clamp(num(c.w, 1), 0.02, 1 - x), h = clamp(num(c.h, 1), 0.02, 1 - y);
    if (w >= 0.999 && h >= 0.999) return null;
    return { x, y, w, h };
}

// Validates the client's project against the uploaded media and turns it into plain numbers.
function normalize(project, media) {
    const clips = (project.clips || []).map(c => {
        const m = media.get(c.mediaId);
        if (!m || m.kind === 'audio') throw new Error('A clip refers to a file that is no longer loaded.');
        if (m.kind === 'image') {
            const dur = clamp(num(c.duration, 5), 0.2, 3600);
            return { m, kind: 'image', in: 0, out: dur, speed: 1, span: dur, dur, crop: cropOf(c.crop), mute: true, volume: 1 };
        }
        const inn = clamp(num(c.in, 0), 0, m.duration);
        const out = clamp(num(c.out, m.duration), inn + 0.05, m.duration);
        const speed = clamp(num(c.speed, 1), 0.1, 5);
        return {
            m, kind: 'video', in: inn, out, speed, span: out - inn, dur: (out - inn) / speed,
            crop: cropOf(c.crop), mute: !!c.mute || !m.acodec, volume: clamp(num(c.volume, 1), 0, 2),
        };
    });
    if (!clips.length) throw new Error('Add at least one clip to the timeline.');
    const total = clips.reduce((s, c) => s + c.dur, 0);

    // Captions arrive as transparent PNGs the browser rendered with the laptop's own fonts
    // (any script, emoji, Calibri on Windows) at a 1080px-tall reference frame.
    const texts = (project.texts || [])
        .map(t => ({
            m: media.get(t.imageId),
            start: clamp(num(t.start, 0), 0, total),
            end: clamp(num(t.start, 0) + num(t.dur, 3), 0, total),
            pos: ['top', 'middle', 'bottom'].includes(t.pos) ? t.pos : 'bottom',
        }))
        .filter(t => t.m && t.m.kind === 'image' && t.end > t.start);

    let music = null;
    if (project.music) {
        const m = media.get(project.music.mediaId);
        if (!m) throw new Error('The music file is no longer loaded.');
        music = {
            m,
            volume: clamp(num(project.music.volume, 0.6), 0, 2),
            orig: clamp(num(project.music.orig, 1), 0, 2),
            mode: project.music.mode === 'replace' ? 'replace' : 'mix',
        };
    }
    const keep = ['av', 'v', 'a'].includes(project.keep) ? project.keep : 'av';
    return { clips, texts, music, keep, total, size: project.size || 'source', allowCopy: project.fast !== false };
}

function outputSize(p) {
    if (SIZES[p.size]) return SIZES[p.size];
    const first = p.clips[0];
    const c = first.crop || { w: 1, h: 1 };
    return [even(first.m.width * c.w), even(first.m.height * c.h)];
}

function signature(m) {
    return [m.vcodec, m.width, m.height, m.pixFmt, Math.round(m.fps * 100), m.acodec, m.sampleRate, m.channels].join('|');
}

// True when the timeline can be assembled by copying the original streams.
function canCopy(p) {
    if (!p.allowCopy || p.keep === 'a' || p.texts.length || p.size !== 'source') return false;
    if (!p.clips.every(c => c.kind === 'video' && !c.crop && c.speed === 1 && c.volume === 1 && !(c.mute && c.m.acodec))) return false;
    return new Set(p.clips.map(c => signature(c.m))).size === 1;
}

function audioTail(p, hasOrigAudio, musicIdx, args, filters, from) {
    // Builds the final audio stream label from the original track (if any) and music (if any).
    const T = f3(p.total);
    if (p.music) {
        const fade = `afade=t=out:st=${f3(Math.max(0, p.total - 1.5))}:d=1.5`;
        const mus = `[${musicIdx}:a]atrim=duration=${T},asetpts=PTS-STARTPTS,volume=${f3(p.music.volume)},${fade}[mus]`;
        filters.push(mus);
        if (hasOrigAudio && p.music.mode === 'mix') {
            filters.push(`${from}volume=${f3(p.music.orig)}[orig]`);
            filters.push('[orig][mus]amix=inputs=2:duration=first:normalize=0[afinal]');
        } else {
            filters.push('[mus]anull[afinal]');
        }
        return '[afinal]';
    }
    return hasOrigAudio ? from : null;
}

function planCopy(p, ctx) {
    const list = path.join(ctx.workDir, `${ctx.id}.ffconcat`);
    const q = s => s.replace(/\\/g, '/').replace(/'/g, "'\\''");
    const lines = ['ffconcat version 1.0'];
    for (const c of p.clips) {
        lines.push(`file '${q(c.m.file)}'`);
        if (c.in > 0.001) lines.push(`inpoint ${f3(c.in)}`);
        if (c.out < c.m.duration - 0.001) lines.push(`outpoint ${f3(c.out)}`);
    }
    fs.writeFileSync(list, lines.join('\n'));

    const first = p.clips[0].m;
    const hasAudio = !!first.acodec && p.keep !== 'v';
    const args = ['-f', 'concat', '-safe', '0', '-i', list];
    if (p.music) args.push('-stream_loop', '-1', '-i', p.music.m.file);

    const filters = [];
    const origLabel = hasAudio ? '[0:a]' : null;
    const finalAudio = audioTail(p, hasAudio, 1, args, filters, origLabel);

    args.push('-map', '0:v:0', '-c:v', 'copy');
    if (p.music) {
        args.push('-filter_complex', filters.join(';'), '-map', finalAudio, '-c:a', 'aac', '-b:a', '192k', '-t', f3(p.total));
    } else if (hasAudio) {
        const copyable = ['aac', 'mp3', 'ac3'].includes(first.acodec);
        args.push('-map', '0:a:0', ...(copyable ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
    } else {
        args.push('-an');
    }
    const mp4ok = ['h264', 'hevc'].includes(first.vcodec);
    const ext = mp4ok ? 'mp4' : 'mkv';
    args.push(...(ext === 'mp4' ? ['-movflags', '+faststart'] : []));
    return { args, ext, mode: 'instant', encoder: 'copy', total: p.total };
}

function planRender(p, ctx, enc) {
    const [W, H] = outputSize(p);
    const args = [];
    const filters = [];
    const wantVideo = p.keep !== 'a';
    const clipAudio = p.keep !== 'v';

    p.clips.forEach((c, i) => {
        if (c.kind === 'image') args.push('-loop', '1', '-framerate', '30', '-t', f3(c.dur), '-i', c.m.file);
        else args.push('-ss', f3(c.in), '-t', f3(c.span), '-i', c.m.file);

        if (wantVideo) {
            const f = [];
            if (c.kind === 'video') f.push('setpts=PTS-STARTPTS');
            if (c.crop) f.push(`crop=trunc(iw*${f3(c.crop.w)}/2)*2:trunc(ih*${f3(c.crop.h)}/2)*2:iw*${f3(c.crop.x)}:ih*${f3(c.crop.y)}`);
            if (c.speed !== 1) f.push(`setpts=PTS/${f3(c.speed)}`);
            f.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
                'setsar=1', 'fps=30', 'format=yuv420p');
            filters.push(`[${i}:v]${f.join(',')}[v${i}]`);
        }
        if (clipAudio) {
            const D = f3(c.dur);
            const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
            if (c.kind === 'video' && !c.mute) {
                const t = c.speed !== 1 ? ',' + atempoChain(c.speed) : '';
                const vol = c.volume !== 1 ? `,volume=${f3(c.volume)}` : '';
                filters.push(`[${i}:a]asetpts=PTS-STARTPTS${t}${vol},${fmt},atrim=duration=${D}[a${i}]`);
            } else {
                filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${D},${fmt}[a${i}]`);
            }
        }
    });

    const needAudioConcat = clipAudio;
    const labels = p.clips.map((_, i) => (wantVideo ? `[v${i}]` : '') + (needAudioConcat ? `[a${i}]` : '')).join('');
    const outs = (wantVideo ? '[vcat]' : '') + (needAudioConcat ? '[acat]' : '');
    filters.push(`${labels}concat=n=${p.clips.length}:v=${wantVideo ? 1 : 0}:a=${needAudioConcat ? 1 : 0}${outs}`);

    // Overlay inputs come after the clips; music (if any) follows them.
    let vLabel = '[vcat]';
    if (wantVideo && p.texts.length) {
        let cur = 'vcat';
        p.texts.forEach((t, i) => {
            const idx = p.clips.length + i;
            args.push('-i', t.m.file);
            const y = t.pos === 'top' ? 'H*0.06' : t.pos === 'middle' ? '(H-h)/2' : 'H-h-H*0.06';
            filters.push(`[${idx}:v]scale=trunc(iw*${H}/1080/2)*2:-2[tx${i}]`);
            filters.push(`[${cur}][tx${i}]overlay=x=(W-w)/2:y=${y}:enable='between(t,${f3(t.start)},${f3(t.end)})'[vt${i}]`);
            cur = `vt${i}`;
        });
        vLabel = `[${cur}]`;
    }

    const musicIdx = p.clips.length + (wantVideo ? p.texts.length : 0);
    if (p.music) args.push('-stream_loop', '-1', '-i', p.music.m.file);
    const finalAudio = (needAudioConcat || p.music)
        ? audioTail(p, needAudioConcat, musicIdx, args, filters, '[acat]')
        : null;

    args.push('-filter_complex', filters.join(';'));
    if (wantVideo) args.push('-map', vLabel, ...enc.args, '-pix_fmt', 'yuv420p');
    else args.push('-vn');
    if (finalAudio) args.push('-map', finalAudio, '-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    args.push('-t', f3(p.total));
    const ext = wantVideo ? 'mp4' : 'm4a';
    if (ext === 'mp4') args.push('-movflags', '+faststart');
    return { args, ext, mode: 'rendered', encoder: wantVideo ? enc.name : 'aac', total: p.total };
}

// One still image (or one video frame), cropped.
function planImage(project, media, ctx) {
    const c = (project.clips || [])[0];
    const m = c && media.get(c.mediaId);
    if (!m || m.kind === 'audio') throw new Error('Select a clip or image to export as a picture.');
    const crop = cropOf(c.crop);
    const at = m.kind === 'video' ? clamp(num(project.frameAt, num(c.in, 0)), 0, Math.max(0, m.duration - 0.05)) : 0;
    const vf = crop
        ? `crop=trunc(iw*${f3(crop.w)}/2)*2:trunc(ih*${f3(crop.h)}/2)*2:iw*${f3(crop.x)}:ih*${f3(crop.y)}`
        : 'null';
    return { args: ['-ss', f3(at), '-i', m.file, '-vf', vf, '-frames:v', '1'], ext: 'png', mode: 'instant', encoder: 'png', total: 0 };
}

async function plan(project, media, ctx, pickEncoder) {
    if (project.format === 'image') return planImage(project, media, ctx);
    const p = normalize(project, media);
    if (canCopy(p)) return planCopy(p, ctx);
    return planRender(p, ctx, await pickEncoder());
}

module.exports = { plan };
