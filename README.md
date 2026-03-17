# Calm Feed

Chrome extension that:

- hides Shorts across YouTube
- hides news sections
- removes sponsored and promoted content blocks
- uses a uBOL-based MV3 adblock core
- adds lightweight HTML5 video speed controls inspired by `igrigorik/videospeed`
- removes recommendation panels on video watch pages
- simplifies the YouTube homepage by removing the sidebar and extra clutter while keeping the search bar and home recommendations
- simplifies Twitter/X by removing the right sidebar, trending modules, and promoted content while keeping the main timeline and normal video expansion behavior

## Structure

- `youtube/content.js` and `youtube/styles.css` handle YouTube-only behavior
- `x/page-script.js`, `x/inject.js`, `x/content.js`, and `x/styles.css` handle Twitter/X-only behavior
- `videospeed/content.js` adds HTML5 video speed keyboard controls across sites
- `adblock/ubol` is a git submodule pointing at `uBlockOrigin/uBOL-home`
- `adblock/runtime` contains the synced uBOL Chromium runtime used by the extension
- `update-adblock.sh` updates the submodule, syncs the Chromium runtime into `adblock/runtime`, and regenerates `manifest.json`

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `/Users/neelr/Documents/Git/calm`.

## Notes

YouTube changes its DOM regularly, so some selectors may need small updates over time.

The adblock portion is based on the upstream uBOL Chromium extension layout. `update-adblock.sh` pulls from `adblock/ubol/chromium/`, syncs the runtime files into `adblock/runtime`, and regenerates the root `manifest.json` with the custom YouTube and X content scripts layered on top while keeping the extension identity as `Calm Feed`.
