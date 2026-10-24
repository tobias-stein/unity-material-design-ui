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
        public const int SCHEMA_VERSION = 2;

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
}
