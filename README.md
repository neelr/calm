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
- auto-translates visible MangaDex reader pages with the OpenAI Responses API
- translates MangaDex chapters with `gpt-image-1.5` and downloads the generated pages as a PDF
- saves the current page to a self-hosted Papery reading list via a one-click bookmark button (token auth)
- highlights selected text on any page (no notes), stored in Papery's D1 and re-anchored on revisit via text + minimal unique context (Curius-style, but not synced to Curius)

## Structure

- `youtube/content.js` and `youtube/styles.css` handle YouTube-only behavior
- `x/page-script.js`, `x/inject.js`, `x/content.js`, and `x/styles.css` handle Twitter/X-only behavior
- `videospeed/content.js` adds HTML5 video speed keyboard controls across sites
- `mangadex/content.js`, `mangadex/styles.css`, and `mangadex/background.js` handle MangaDex page OCR, translation, overlays, and chapter PDF download
- `papery/content.js`, `papery/content.css`, and `papery/papery-bridge.js` add the save-to-reading-list button; the bridge runs in the service worker so page CSP can't block saves and the token stays out of the page — configured from the popup (endpoint + token, stored as `paperyEndpoint`/`paperyToken`)
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

MangaDex translation is for personal use with your own OpenAI API key. Turn on the MangaDex toggle in the popup and open a `mangadex.org/chapter/...` reader page. The extension sends the currently visible page image to `gpt-5.5` and renders translated overlay boxes.
