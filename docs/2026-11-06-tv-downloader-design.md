# TV Downloader — design decisions — 2026-11-06

## Goal
Bookmark legal direct-download links from a phone or laptop. Pick one on the TV to download it to the USB drive, then browse and play.
TV: Samsung UA32N4300 (2018, Tizen 4), TizenBrew 2.0.5. Feasibility proven in
`~/tv-network-discovery/docs/2026-11-06-tizenbrew-usb-feasibility.md`.

## Scope decision
- The user first asked for a scraper that would simplify downloads from a piracy site (moviezda). **Declined.**
- Built a generic, user-driven link downloader instead. It has no site-specific scraping. Users add direct links they have the right to download.

## Decisions
| Topic | Decision | Reason |
|---|---|---|
| Discovery | QR + IP on the TV, plus an mDNS name **`tv-dl.local`** (user's choice of name) | QR always works. mDNS is best-effort, because Tizen's own responder also uses 5353 (we use SO_REUSEADDR) |
| Auth on the web page | **None** (user's decision) | The LAN page can only add, list and remove links. Downloads and files are TV-only |
| Split servers | LAN `0.0.0.0:80→8090` (links only) and local `127.0.0.1:8091` (downloads, files, playback) | Nothing on the drive is reachable from the LAN |
| Storage of links | `<drive>/.tvdl/links.json`, falling back to `$HOME/.tvdl` | Travels with the drive and survives TizenBrew reinstalls |
| Concurrency | One download at a time, FIFO queue | Slow Wi-Fi and the TV's CPU |
| Resume | Range requests, `.part` file per link id | TVs get switched off mid-download |
| TLS | Fetch the Mozilla CA bundle from jsDelivr (our repo), then fall back to unverified with a UI label | Node 4.4.3 has 2016-era roots |
| FAT32 | Refuse files over 4 GB on `vfat` | Writes would fail at 4 GB |
| Repo | New public repo `5hanth/tv-downloader` | TizenBrew loads via jsDelivr, so it must be public |

## Tested on the Mac (2026-11-06)
- Adding links via the web API works; invalid URLs are rejected; HTML pages are flagged.
- The LAN port returns 404 for download and file endpoints.
- Queue: 3 downloads ran sequentially, and the HTML link failed with a clear message.
- **Stop + resume** of a 30 MB file: the MD5 matched a direct download.
- Range serving returns 206 with correct headers. Path traversal (`../`) is rejected.
- Links persist across a service restart.
- Headless browser at 1366×768: Links tab, Downloads tab, player (MP4 plays and seeks) and phone page all render with no JS errors.

## Not yet verified on the TV
- Binding port 80 vs falling back to 8090 (depends on the uid).
- Inbound LAN connections to the TV.
- mDNS coexisting with Tizen's responder.
- Loading the CA bundle under Node 4.4.3.
- Remote media keys.

## 2026-11-07 — uploads ("AirDrop-like")
- AirDrop isn't possible: it's Apple-only and uses AWDL. Instead:
  - Write-only upload endpoint `PUT/POST /api/upload?name=` on the LAN server.
  - A drop zone on the web page.
  - `mac/send-to-tv.sh` and a Finder Quick Action.
- The user accepted that the web page can now write files, still without a PIN.
- Tested on the Mac:
  - A 50 MB upload arrived with a matching MD5.
  - Tamil and Unicode filenames come through intact (fixed a byte-encoding bug in the bash URL-encoder).
  - `../../evil.txt` is saved as `Downloads/evil.txt`.
  - An aborted upload leaves no partial file.
  - The LAN port still returns 404 for listing and reading files.
- **Verified on the real TV:**
  - `tv-dl.local` resolves to 192.168.0.127 over mDNS (it coexists with Tizen's responder).
  - Port 80 isn't allowed, so the page is served on **8090**.
  - Inbound LAN connections work.
  - The pen drive is seen as `USBDriveA1` (vfat).

## 2026-11-07 — speed control, mDNS fix, release process
- Player: Yellow key cycles playback speed 1/1.25/1.5/1.75/2×. Tested headless. If the TV ignores `playbackRate`, the UI shows a toast.
- mDNS: Mac and phone resolvers waited **5 s** for an IPv6 (AAAA) answer. The service now answers AAAA with an NSEC
  ("A only") and adds NSEC to A answers. Tested locally: lookup went from 5 s to 0.015 s.
- **Gotchas found:**
  - The TizenBrew service survives closing TizenBrew. Only a TV reboot (hold power) restarts it.
  - jsDelivr's version-less `gh/` URL ≠ `@main`. It resolves to the latest tag and is cached per file.
  - Purges are throttled to about once an hour.
  - Fix: tag releases (v0.2.0) and purge the version-less URLs.
