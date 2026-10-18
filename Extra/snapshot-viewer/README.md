# Snapshot Viewer

Standalone HTML renderer for UI snapshots exported at runtime by
`Assets/Runtime/Telemetry/` (schemaVersion 1). Renders with Material 3 tokens —
no build step, no framework.

## Run

```sh
cd Extra/snapshot-viewer
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly from disk (file://) also works for loading local
`.yaml` / `.yaml.gz` files via drag-and-drop — only the **Load sample** button
needs HTTP.

## Usage

- **Open snapshot… / drag & drop** — load an exported snapshot
  (`.yaml`, or gzip-compressed `.yaml.gz`; gzip is auto-detected).
- **Replica** (default) — pixel-faithful absolute positioning using the
  captured runtime rects (root-view space, top-left origin).
- **Flex** — semantic re-layout built from the captured `LayoutGroup` /
  `LayoutElement` / `ContentSizeFitter` data (flex-direction, gap, padding,
  alignment) — responsive reconstruction of the Unity layout.
- **layout boxes** — outline pure layout containers.
- **Tree / Inspector** — navigate hierarchy; click any element to inspect its
  `_id`, geometry, roles, resolved values and serialized component data.

The status bar shows a warning when the geometry looks unrenderable — e.g.
*“N of M nodes lie outside the root”*, which means the snapshot was captured
before Unity applied layout (re-capture after the view settled).

## Where snapshots come from

Default export directory (per platform):

- macOS: `~/Library/Application Support/<ProductName>/Telemetry/snapshots/`
- Windows: `%USERPROFILE%\AppData\LocalLow\<ProductName>\Telemetry\snapshots\`
- Linux: `~/.config/unity3d/<CompanyName>/<ProductName>/Telemetry/snapshots/`
- iOS/Android: the app's persistent data path

Triggers (configurable via `Resources/Settings/TelemetrySettings` asset or
`Telemetry.configure(cfg => …)`):

- **F9** (editor/dev builds by default) — capture the active view
- **view transitions** — auto-capture after `pushAsync`/`popAsync` completes
  (rate-limited, deduped, retention-pruned)

## Schema (v1)

```yaml
schemaVersion: 1
timestampUtc: ISO-8601
app:      { productName, unityVersion, platform, deviceType, screenWidth, screenHeight, scaleFactor }
view:     { id, name, type, layer }              # captured root view
theme:    { seedColor, isDark, deviceType,
            palette: { ColorRole -> '#RRGGBB[AA]' }, # resolved Material 3 roles
            spacing: { Spacing -> units },
            sizing:  { Sizing -> units },
            typography: { TextRole -> { fontSize, fontWeight, … } } }
nodes:    # flat list, parents before children
  - id: <guid | anon:path>      # stable _id from the Unity runtime
    kind: ui | layout           # IUI element vs pure RectTransform container
    name, type, parentId, siblingIndex, active, isView, layer
    rect:      { x, y, width, height }   # root space, top-left origin (y down)
    rectLocal: { x, y, width, height }   # parent-local, pivot origin
    anchor:    { pivot…, anchorMin/Max, anchoredPos, sizeDelta }
    layout:            # present if LayoutGroup
      type: Horizontal | Vertical | Custom
      paddingLeft/Right/Top/Bottom, spacing, childAlignment,
      controlChildWidth/Height, childForceExpandWidth/Height, reverseArrangement,
      runtimeSwitchable          # HVLayoutGroup (direction flipped in code)
    layoutElement:     # present if LayoutElement
      minWidth/minHeight/preferredWidth/preferredHeight/flexibleWidth/flexibleHeight, ignoreLayout
    contentSizeFitter: { horizontalMode, verticalMode }
    data: { … }          # serialized *Data struct (enums as strings, colors as
                         # '#RRGGBB[AA]', vectors as arrays, MaterialSymbolData as
                         # {code, fill}; UnityEvents are omitted)
    resolved: { colorRoles, textRole, text, fontSize, fontWeight, fontName,
                textWidth, color, backgroundColor, fillColor, outlineColor,
                outlineWidth, opacity, cornerRadius }
                # fontSize/color/fontName/fontWeight/textWidth only when a
                # TMP_Text is present; fontWeight is the SDF asset's baked
                # style (e.g. "Regular") — what Unity actually rendered,
                # winning over the theme role's nominal weight; textWidth is
                # TMP's preferredWidth (Unity's own single-line measurement —
                # the viewer only shows "..." when Unity itself truncated);
                # opacity only when a CanvasGroup is present; cornerRadius /
                # fillColor / outlineColor+outlineWidth only when an SDF shape
                # is present (fill = SDF fill × Graphic tint × CanvasRenderer
                # color — the last one is where Button's ColorBlock role tint
                # lands via CrossFadeColor); backgroundColor is the Image color
                # (absent = not captured, not zero)
    error: "…"           # per-node capture failure (export continues)
```

The viewer derives hierarchy from `parentId` + `siblingsIndex`, so snapshots
stay renderable even if optional fields are missing. Newer `schemaVersion`
values render best-effort with a warning.

## Text rendering

For `mdu.ui.Text` nodes the viewer maps the captured TMP state onto CSS:

- **font-size**: `resolved.fontSize` (actual per-instance TMP size) wins;
  `theme.typography[role].fontSize` is the fallback when absent.
- **font-weight**: `resolved.fontWeight` (the SDF asset's baked style, e.g.
  `Regular`) wins over `theme.typography[role].fontWeight` — a single-weight
  SDF renders everything at its baked weight regardless of the requested role.
- **letter-spacing**: theme `characterSpacing` is applied with TMP semantics
  (`characterSpacing × fontSize × 0.01` px), not as raw pixels.
- **wrapping**: `data.wrapping: NoWrap` → `white-space: nowrap` (Unity renders
  these on one line regardless of rect width); `Standard`/`PreserveSpaces` →
  `pre-wrap`.
- **overflow**: `data.overflow: Ellipsis` → `overflow: hidden` +
  `text-overflow: ellipsis` **only when Unity truncated** (captured
  `resolved.textWidth` exceeds the rect — SDF glyph advances can't be matched
  exactly by the browser font, ±1–5px per string); `Overflow` → visible
  (matches TMP overflow).
- **alignment**: `data.horizontalAlignment` `Center`/`Right`/`Justified` →
  `text-align`; `None`/`Left` → unset (left).

Without the `NoWrap`/`Ellipsis` mapping, browser font metrics (Roboto via
Google Fonts vs TMP's SDF bake) differ by a few pixels from Unity's
measurements, and CSS `pre-wrap` would wrap labels that Unity renders on one
line.

## Dependencies

- `vendor/js-yaml.min.js` — vendored (offline parsing), js-yaml 4.1.0 (MIT)
- Google Fonts (CDN, optional): Roboto + Material Symbols Outlined — icons fall
  back to raw glyph codepoints when offline
