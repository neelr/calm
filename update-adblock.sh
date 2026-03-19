#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

SUBMODULE_PATH="adblock/ubol"
CHROMIUM_DIR="$SUBMODULE_PATH/chromium"
RULESET_DIR="$CHROMIUM_DIR/rulesets/main"
RUNTIME_DIR="adblock/runtime"
SYNC_DIRS="css img js lib rulesets web_accessible_resources"
SYNC_FILES="dashboard.html matched-rules.html picker-ui.html popup.html report.html strictblock.html unpicker-ui.html zapper-ui.html managed_storage.json LICENSE.txt"

git submodule update --init --remote "$SUBMODULE_PATH"

rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
rm -rf "$ROOT_DIR/_locales"

for dir in $SYNC_DIRS; do
  cp -R "$CHROMIUM_DIR/$dir" "$RUNTIME_DIR/$dir"
done

cp -R "$CHROMIUM_DIR/_locales" "$ROOT_DIR/_locales"

for file in $SYNC_FILES; do
  cp "$CHROMIUM_DIR/$file" "$RUNTIME_DIR/$file"
done

find "$ROOT_DIR" -maxdepth 1 \
  \( -name 'css' -o -name 'img' -o -name 'js' -o -name 'lib' -o -name 'rulesets' -o -name 'web_accessible_resources' -o -name 'dashboard.html' -o -name 'matched-rules.html' -o -name 'picker-ui.html' -o -name 'report.html' -o -name 'strictblock.html' -o -name 'unpicker-ui.html' -o -name 'zapper-ui.html' -o -name 'managed_storage.json' -o -name 'LICENSE.txt' -o -name '_metadata' \) \
  -exec rm -rf {} +

jq '
  .action.default_popup = "popup.html" |
  del(.action.default_icon) |
  .background.service_worker = "adblock/runtime/js/background.js" |
  .declarative_net_request.rule_resources |= map(
    .path |= ("adblock/runtime" + .)
  ) |
  .description = "Clean up YouTube and Twitter/X and add a uBOL-based MV3 adblock core." |
  del(.icons) |
  .name = "Calm Feed" |
  .short_name = "Calm Feed" |
  .options_page = "adblock/runtime/dashboard.html" |
  .permissions |= (
    (
      if index("tabs") then .
      else . + ["tabs"]
      end
    ) | map(select(. != "activeTab"))
  ) |
  .storage.managed_schema = "adblock/runtime/managed_storage.json" |
  .version = "1.0.0" |
  .web_accessible_resources |= map(
    .resources |= map(
      if startswith("/") then "adblock/runtime" + .
      else "adblock/runtime/" + .
      end
    )
  ) |
  .web_accessible_resources += [
    {
      "resources": ["x/page-script.js"],
      "matches": [
        "https://twitter.com/*",
        "https://www.twitter.com/*",
        "https://x.com/*",
        "https://www.x.com/*"
      ]
    }
  ] |
  .content_scripts = [
    {
      "matches": ["<all_urls>"],
      "js": ["videospeed/content.js"],
      "run_at": "document_start"
    },
    {
      "matches": ["https://www.youtube.com/*"],
      "js": ["youtube/content.js"],
      "css": ["youtube/styles.css"],
      "run_at": "document_start"
    },
    {
      "matches": [
        "https://twitter.com/*",
        "https://www.twitter.com/*",
        "https://x.com/*",
        "https://www.x.com/*"
      ],
      "js": ["x/inject.js", "x/content.js"],
      "css": ["x/styles.css"],
      "run_at": "document_start"
    }
  ]
' "$CHROMIUM_DIR/manifest.json" > "$ROOT_DIR/manifest.json"

jq empty "$ROOT_DIR/manifest.json"

find "$RUNTIME_DIR" -type f \( -name '*.html' -o -name '*.js' \) -print0 | while IFS= read -r -d '' file; do
  perl -0pi -e 's#/css/#/adblock/runtime/css/#g; s#/js/#/adblock/runtime/js/#g; s#/img/#/adblock/runtime/img/#g; s#/rulesets/#/adblock/runtime/rulesets/#g; s#/web_accessible_resources/#/adblock/runtime/web_accessible_resources/#g; s#/strictblock\.html#/adblock/runtime/strictblock.html#g; s#/picker-ui\.html#/adblock/runtime/picker-ui.html#g; s#/unpicker-ui\.html#/adblock/runtime/unpicker-ui.html#g; s#/zapper-ui\.html#/adblock/runtime/zapper-ui.html#g; s#/report\.html#/adblock/runtime/report.html#g; s#runtime\.getURL\('/'\)#runtime.getURL('/adblock/runtime/')#g' "$file"
done

for ruleset in \
  ublock-filters.json \
  ublock-badware.json \
  easylist.json \
  easyprivacy.json \
  pgl.json \
  urlhaus-full.json
do
  jq empty "$RULESET_DIR/$ruleset"
done

echo "Updated $SUBMODULE_PATH"
echo "Synced Chromium runtime into $RUNTIME_DIR"
echo "Validated manifest and core uBOL rulesets"
