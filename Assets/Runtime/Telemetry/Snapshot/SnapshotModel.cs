using System.Collections.Generic;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Serialized UI snapshot ("schema v2": adds <see cref="SnapshotAppInfo.sessionId"/>).
    /// Pure POCO data: primitives, enums as strings, nested POCOs and dictionaries —
    /// nothing Unity-serializable-specific crosses the YAML boundary.
    ///
    /// Coordinate convention: <see cref="SnapshotRect"/> values for <c>rect</c> are
    /// root-view space with a top-left origin (y grows downward, HTML-style).
    /// <c>rectLocal</c> keeps Unity's parent-local/pivot-origin values.
    /// </summary>
    public class UISnapshot
    {
        /// <summary>
        /// Schema the YAML escape hatch serializes (<see cref="TelemetryConfig.snapshotFormat"/>=Yaml).
        /// Fixed — the YAML writer is the legacy debug path, byte-compatible forever.
        /// </summary>
        public const int SCHEMA_VERSION = 2;

        /// <summary>
        /// Schema of the binary format ("MDS", ADR-0008: varint + string table + columnar-leaning
        /// node stream + ADR-0007 session theme refs + ADR-0009 delta chains). The YAML schema
        /// intentionally stays at 2 — the migration is one versioned format change from v2-YAML
        /// (and gzip-of-it) to v3-binary, never a YAML bump.
        /// </summary>
        public const int BINARY_SCHEMA_VERSION = 3;

        public int schemaVersion;
        public string timestampUtc;
        public SnapshotAppInfo app;
        public SnapshotViewInfo view;
        public SnapshotTheme theme;
        public List<SnapshotNode> nodes;

        /// <summary>
        /// Why this snapshot was captured (the trigger source): "view-transition",
        /// "popup-shown", "mutation", "hotkey", or the paced variants of these
        /// ("...:queued"). Null on manual/debug captures before the schema grew
        /// the field — consumers must treat null as "unspecified".
        /// </summary>
        public string source;
    }

    public class SnapshotAppInfo
    {
        public string productName;
        public string productVersion;
        public string unityVersion;
        public string platform;
        public string deviceType;

        /// <summary>
        /// Telemetry session id this snapshot belongs to (same id as every
        /// exported event's "session" tag) — correlates snapshots with the
        /// event timeline. Null when telemetry is not bootstrapped.
        /// </summary>
        public string sessionId;

        public float screenWidth;
        public float screenHeight;
        public float scaleFactor;
    }

    public class SnapshotViewInfo
    {
        public string id;
        public string name;
        public string type;
        public string layer;
    }

    /// <summary>
    /// Theme/tokens active at capture time. The seed + dark flag allow the HTML side
    /// to regenerate the full Material 3 palette; the resolved maps are the
    /// guaranteed fallback so rendering never breaks.
    /// </summary>
    public class SnapshotTheme
    {
        public string seedColor;
        public bool isDark;
        public string deviceType;
        public Dictionary<string, string> palette;    // ColorRole -> #RRGGBB[AA]
        public Dictionary<string, float> spacing;     // Spacing -> unity units
        public Dictionary<string, float> sizing;      // Sizing -> unity units
        public Dictionary<string, SnapshotTextStyle> typography; // TextRole -> style
    }

    public class SnapshotTextStyle
    {
        public float fontSize;
        public string fontWeight;
        public string fontStyle;
        public string fontName;
        public float characterSpacing;
        public float lineSpacing;
    }

    public class SnapshotNode
    {
        public string id;
        public string kind;          // "ui" (IUI element) | "layout" (pure RectTransform container)
        public string name;
        public string type;
        public string parentId;      // absent on root
        public int siblingIndex;
        public bool active;
        public bool isView;
        public string layer;         // CanvasLayer when isView
        public SnapshotRect rect;        // root-view space, top-left origin
        public SnapshotRect rectLocal;   // parent-local, pivot origin
        public SnapshotAnchor anchor;
        public SnapshotLayout layout;             // present when a LayoutGroup exists
        public SnapshotLayoutElement layoutElement; // present when a LayoutElement exists
        public SnapshotContentSizeFitter contentSizeFitter; // present when a ContentSizeFitter exists
        public Dictionary<string, object> data;   // dumped *Data struct (UnityEvents skipped)
        public SnapshotResolved resolved;         // currently applied visual state
        public List<string> children;
        public string error;          // per-node capture failure marker (robustness)
    }

    public class SnapshotRect
    {
        public float x;
        public float y;
        public float width;
        public float height;
    }

    public class SnapshotAnchor
    {
        public float pivotX;
        public float pivotY;
        public float anchorMinX;
        public float anchorMinY;
        public float anchorMaxX;
        public float anchorMaxY;
        public float anchoredX;
        public float anchoredY;
        public float sizeX;
        public float sizeY;
    }

    public class SnapshotLayout
    {
        public string type;          // "Horizontal" | "Vertical" | "Custom"
        public bool runtimeSwitchable; // HVLayoutGroup (direction flipped in code)
        public float paddingLeft;
        public float paddingRight;
        public float paddingTop;
        public float paddingBottom;
        public float spacing;
        public string childAlignment;
        public bool controlChildWidth;
        public bool controlChildHeight;
        public bool childForceExpandWidth;
        public bool childForceExpandHeight;
        public bool reverseArrangement;
    }

    public class SnapshotLayoutElement
    {
        public float minWidth;
        public float minHeight;
        public float preferredWidth;
        public float preferredHeight;
        public float flexibleWidth;
        public float flexibleHeight;
        public bool ignoreLayout;
    }

    public class SnapshotContentSizeFitter
    {
        public string horizontalMode; // Unconstrained | MinSize | PreferredSize | MinAndMaxSize
        public string verticalMode;
    }

    /// <summary>Best-effort snapshot of what is currently applied on the GameObject.</summary>
    public class SnapshotResolved
    {
        public Dictionary<string, string> colorRoles; // data field name -> ColorRole
        public string textRole;                       // data textRole field if present
        public string text;                           // TMP_Text content on this node
        public float? fontSize;                       // null when no TMP_Text on this node
        public string fontWeight;                     // baked SDF style (faceInfo.styleName, e.g. "Regular"); wins over theme role weight
        public string fontName;
        public float? textWidth;                      // TMP preferredWidth: Unity's own single-line text measurement
        public string color;                           // text/graphic color #hex
        public string backgroundColor;                 // Image color #hex
        public string fillColor;                       // SDF fill × Graphic tint × CanvasRenderer color (Button ColorBlock); null when no visible SDF fill
        public string outlineColor;                    // SDF outline color when outline enabled
        public float? outlineWidth;                    // SDF outline width (unity units); null when no outline
        public float? opacity;                         // CanvasGroup alpha; null when no CanvasGroup
        public float? cornerRadius;                    // SDFQuad radius; null when no SDFQuad
    }

    // ---------------------------------------------------------------------------
    // ADR-0009: delta mutation captures (chain format on top of the v3 binary one).
    // A delta is a *storage* format artifact — the viewer/server materializes whole
    // trees; every existing consumer keeps dealing in whole snapshots only.
    // ---------------------------------------------------------------------------

    /// <summary>
    /// One delta capture's content: the sparse diff between the chain state
    /// (the last *exported* capture of the view's open cycle) and the freshly
    /// walked tree. Serialized by <see cref="UISnapshotBinaryWriter"/>
    /// (contentMode=delta); never carried in the POCO <see cref="UISnapshot"/>.
    /// </summary>
    public class SnapshotDelta
    {
        /// <summary>SHA-256 hex of the file this delta's diffs were computed against —
        /// the previous chain member (anchor or earlier delta), the immediate parent,
        /// not only the chain root (that is <see cref="anchorHash"/>).</summary>
        public string baseHash;

        /// <summary>Ancestor file hashes of this chain segment, anchor first, self excluded.
        /// The full segment rides along so a consumer never needs ledger resolvability to walk the chain (ADR-0008 principle 4: "parse.ts gains a magic sniff ... same ParsedSnapshot" — chain files must stay loadable by the store alone).</summary>
        public List<string> bases;

        /// <summary>Post-delta (materialized) tree node count — the ledger's nodeCount stays honest.</summary>
        public int nodeCount;

        /// <summary>FNV-1a fingerprint over the materialized post-delta tree (same value
        /// <see cref="UISnapshotBuilder.fingerprint"/> computes; kept as the u32 form for the file).</summary>
        public uint fingerprint;

        public List<string> removedIds;
        /// <summary>Full node payloads (same encoding as anchor nodes, patch flavor: with parent ref).</summary>
        public List<SnapshotNode> added;
        /// <summary>Nodes whose any tracked payload field changed — re-encoded whole (id → identity).</summary>
        public List<SnapshotNode> changed;

        /// <summary>Zero-alloc-ish diff, so an empty delta is impossible by construction.</summary>
        public bool isEmpty => (removedIds?.Count ?? 0) == 0 && (added?.Count ?? 0) == 0 && (changed?.Count ?? 0) == 0;
    }

    /// <summary>
    /// Per-view *cycle* chain state (the ADR-0009 "stateful storage"): what the
    /// runtime holds between the anchor capture of a view's open cycle and the
    /// cycle end. Append-only from the trigger loop's point of view; one state
    /// per open view, reset on view end (mapped 1:1 onto the triggers' existing
    /// cycle-scoped maps).
    /// </summary>
    public sealed class SnapshotChainState
    {
        /// <summary>First exported file of the cycle (the anchor's sha256).</summary>
        public string anchorHash;
        /// <summary>Ancestor file hashes of the *last exported* chain member, anchor first, self
        /// excluded (empty right after the anchor). The next delta's `bases` = this + lastHash,
        /// so the chain segment always travels in the file bytes — a consumer resolves the
        /// chain from the store alone, without ledger resolvability (see UISnapshotBinaryWriter).</summary>
        public List<string> bases = new List<string>();
        /// <summary>Hash of the last exported chain member (the base the next delta diffs against).</summary>
        public string lastHash;
        /// <summary>Last exported materialized tree — the diff target. Replaced whole after each successful export.</summary>
        public UISnapshot materialized;
    }
}
