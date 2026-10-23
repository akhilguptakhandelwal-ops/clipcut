# ClipCut

A fast, Clipchamp-style video editor that runs on your own laptop. Join clips, trim, change speed, crop videos and photos, add captions and music, then export, usually in well under a second, because ClipCut copies the original video instead of re-rendering it whenever it can.

Nothing is uploaded anywhere. The app runs a small local server on `127.0.0.1` and opens in your browser.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

On Windows you can double-click `start.bat` instead. ClipCut ships with its own ffmpeg (via `ffmpeg-static`); if that download is blocked it falls back to an ffmpeg on your `PATH`.

## What you can do

| | |
|---|---|
| **Join** | Import several clips and photos, add them to the timeline, drag to reorder. |
| **Cut** | Drag a clip's edges to trim, or press `S` to split at the playhead. Delete what you don't want. |
| **Voice / video / both** | Mute a clip (cut the voice), or export *video only*, *voice only* (audio file), or both. |
| **Speed** | 0.25× to 4×, audio pitch-corrected. |
| **Crop** | Videos and photos. Free-form or 16:9, 9:16, 1:1, 4:5, 4:3. Export a cropped picture from any photo or video frame. |
| **Text & captions** | Titles anywhere on screen, or import an `.srt` file as captions. Any language, including Hindi and emoji, rendered with your system fonts (Calibri on Windows). |
| **Music** | Mix under the original sound or replace it. Loops to fit and fades out. |
| **Canvas** | Match the first clip, 16:9, 9:16 vertical or 1:1 square. |

Shortcuts: `Space` play/pause · `S` split · `Del` delete · `Ctrl+Z` / `Ctrl+Y` undo/redo · `←` `→` step (hold `Shift` for 1 s).

## Why export is fast

ClipCut picks the cheapest path for each export and tells you which one it used:

* **Instant** (copies the streams, no re-render): trimming, joining clips that share a format, muting, voice-only / video-only, adding music (only the audio is encoded). Original quality. A cut can land on the nearest keyframe, so turn off *Instant mode* in the export dialog if you need frame-exact cuts.
* **Rendered** (re-encodes video): speed changes, crop, text and captions, mixed-size clips, canvas changes. ClipCut tests for your GPU's H.264 encoder (NVIDIA NVENC, Apple VideoToolbox, Intel Quick Sync, AMD AMF) and uses it; otherwise it uses a fast CPU preset.

## Notes

* The preview plays through your browser, so it can only show formats the browser supports (H.264/AAC MP4 and WebM are safe; some HEVC or MKV files may not preview but still export correctly).
* Imported files are copied into a temporary folder that is deleted when you stop the app.

## Tests

```bash
npm test
```

Generates sample media and checks every export path (instant trim/join, voice/video only, music, speed, crop, mixed sizes, captions, picture export).
