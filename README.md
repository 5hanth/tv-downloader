# TV Downloads — a download manager for Samsung TVs

A [TizenBrew](https://github.com/reisxd/TizenBrew) module for Samsung Tizen TVs:

1. **Add links from your phone or laptop.** Open **http://tv-dl.local** (or scan the QR code on the TV) and paste direct download links.
2. **Download from the TV.** Pick a link with the remote and press OK. The file downloads to the USB drive plugged into the TV.
3. **Watch.** Browse the *Downloads* tab and play files with the built-in player.

The web page can only **add, list and remove links**. Downloads can only be started from the TV, and files on
the drive are never exposed to the network.

> Only download content you have the right to download: public-domain or Creative Commons media, your own files, and so on.

## Remote controls
| Screen | Key | Action |
|---|---|---|
| Links | ▲ ▼ | Select a link |
| | OK | Download / stop (resumes where it left off) / play once done |
| | 🔴 Red ×2 | Remove the link |
| Downloads | OK | Play |
| | 🔴 Red ×2 | Delete the file from the USB drive |
| Player | OK / ⏯ | Play / pause |
| | ◀ ▶ / ⏪ ⏩ | −/+ 10 s |
| | ▲ ▼ | +/− 1 min |
| | BACK / ⏹ | Close |
| Any | ◀ ▶ (in list) | Switch tab |

## Install
In TizenBrew: **Module Manager → Add GitHub module →** `5hanth/tv-downloader`, then open **TV Downloads**.
To keep the web page available whenever TizenBrew is running, enable autolaunch for this module's service in TizenBrew **Settings**.

## Features
- One download at a time, with progress, speed and time remaining. Downloads are queued.
- **Resume:** stopped or interrupted downloads continue from where they left off, if the server supports ranges.
  Network drops are retried 3×.
- Partial files are saved as `Downloads/.tvdl-<id>.part` and renamed only when complete.
- The file name comes from your name for the link, the server's `Content-Disposition`, or the URL, and is cleaned up for FAT32.
- Links that return a web page instead of a file are flagged.
- **FAT32 guard:** files larger than 4 GB are refused on `vfat` drives. Use exFAT for big files.
- Links are stored on the USB drive (`.tvdl/links.json`), so the list travels with the drive.
- TLS: loads a current Mozilla CA bundle (`service/cacert.pem`) because the TV's Node 4 has outdated roots.
  If verification still fails, the download continues unverified and is labelled *certificate not verified*.

## How it works
```
phone/laptop ──► :80 (or :8090)  LAN web page — add/list/remove links only
                 mDNS responder  answers  tv-dl.local → TV IP
TV UI ─────────► 127.0.0.1:8091  local API — downloads, file list, Range-enabled file serving for <video>
                       │
                       └── /opt/media/USBDriveA1/{Downloads/, .tvdl/links.json}
```
The service is ES5 with Node built-ins only (Tizen 4 ships Node 4.4.3). The UI is ES5 for the Chromium 56-era engine.
CSS and JS are inline because TizenBrew's module proxy doesn't send Content-Type headers.

## Playback support
The TV's HTML5 player handles **MP4 (H.264/AAC)** reliably, and WebM/VP9 depending on the model. MKV, AVI and HEVC may
download fine but not play in the app. Use the TV's own *Source → USB* media player for those.

## Develop
```bash
node dev/serve.js
# TV UI:    http://127.0.0.1:8092/app/index.html   (arrows, Enter, Esc; R key isn't mapped — use the API to delete)
# Web page: http://127.0.0.1:8090/
```
The dev mode uses a fake drive in `dev/media/USBDriveA1`, binds the web page to localhost only, and disables mDNS.
