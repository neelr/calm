# Adblock

This folder contains the adblocking layer for this extension.

## Layout

- `ubol/` is a git submodule pointing to `https://github.com/uBlockOrigin/uBOL-home`
- `runtime/` contains the synced upstream Chromium extension runtime used by Chrome
- `update-adblock.sh` syncs the upstream Chromium extension runtime from `ubol/chromium/` into `runtime/`
- the root extension then runs the synced uBOL runtime plus the custom `youtube/` and `x/` content scripts

## Why This Shape

uBOL’s Chromium code expects its own runtime files to live under a single extension runtime layout. Keeping `ubol/` as a submodule preserves attribution and update history, while `update-adblock.sh` materializes a patched runtime under `adblock/runtime/` so the extension can still present itself as `Calm Feed`.

## Attribution

uBOL is upstream work from the uBlock Origin project. This repository references selected rulesets from the `uBOL-home` submodule so attribution and updates stay tied to upstream history.
