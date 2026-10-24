// Assembles the phone app's web folder (mobile/www) from the shared editor in ../public.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(__dirname, 'www');
const vendor = path.join(www, 'vendor');
const mod = p => path.join(__dirname, 'node_modules', p);

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

// the editor itself, minus the laptop-only backend
for (const f of fs.readdirSync(path.join(root, 'public'))) {
    if (f === 'backend-server.js') continue;
    fs.copyFileSync(path.join(root, 'public', f), path.join(www, f));
}
// the export planner is shared with the laptop app, byte for byte
fs.copyFileSync(path.join(root, 'lib', 'export.js'), path.join(www, 'planner.js'));
fs.copyFileSync(path.join(__dirname, 'src', 'backend-wasm.js'), path.join(www, 'backend-wasm.js'));

// ffmpeg.wasm, bundled inside the app so nothing is downloaded at runtime
fs.copyFileSync(mod('@ffmpeg/ffmpeg/dist/umd/ffmpeg.js'), path.join(vendor, 'ffmpeg.js'));
fs.copyFileSync(mod('@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js'), path.join(vendor, '814.ffmpeg.js'));
fs.copyFileSync(mod('@ffmpeg/core/dist/umd/ffmpeg-core.js'), path.join(vendor, 'ffmpeg-core.js'));
fs.copyFileSync(mod('@ffmpeg/core/dist/umd/ffmpeg-core.wasm'), path.join(vendor, 'ffmpeg-core.wasm'));

const indexPath = path.join(www, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('<script src="backend-server.js"></script>',
    '<script src="vendor/ffmpeg.js"></script>\n<script src="planner.js"></script>\n<script src="backend-wasm.js"></script>');
html = html.replace('<body>', '<body class="phone">');
fs.writeFileSync(indexPath, html);
console.log('Built', www);
