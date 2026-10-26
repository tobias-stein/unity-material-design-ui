using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Snapshot storage format v3 ("MDS") — ADR-0008 (binary format), ADR-0007
    /// (session theme manifest ref) and ADR-0009 (delta mutation chain) as ONE
    /// migration. Zero dependencies, reflection-free, IL2CPP-safe: a plain byte
    /// layout serialized with the same primitives the .NET framework knows —
    /// LEB128 varints, an interned string table and 0.01-quantized ints.
    ///
    /// Wire format (schema 3), the contract the TS decoder
    /// (Extra/telemetry-viewer packages/snapshot-render src/binaryDecode.ts +
    /// the server's parse.ts) must mirror exactly:
    ///
    ///   Header:  "MDS\n" (4B) | formatVersion u8=3 | schemaVersion u8=3 | flags u8
    ///            flags bit0-1 contentMode (0 anchor, 1 delta), bit2 themeInline,
    ///            bits3-7 reserved 0.
    ///   String   sequential LEB128 entries: byteLength + UTF-8. Referenced by
    ///   Table:   1-based LEB128 refs (0 = null). Everything but the theme-ref
    ///            hash and the chain hashes is interned.
    ///   Theme:   mode LEB128 (0 absent, 1 inline, 2 manifest ref); inline =
    ///            the full SnapshotTheme with interned strings; ref = inline
    ///            hex hash (the FNV-1a hash computeThemeHash already produces).
    ///   App/View/POD section — ints zigzag LEB128, floats quantized i32 at the
    ///   0.01 round the builder already applies (byte-exact per the ADR's
    ///   "lossless relative to current YAML" contract).
    ///   Nodes
    ///   (anchor):count LEB128, then pre-order per node:
    ///            childCount, siblingIndex, info bitset, id/name/type refs,
    ///            optional layer/rect/rectLocal/anchor/layout/layoutElement/
    ///            contentSizeFitter/data/resolved/error sections. The parent
    ///            chain is the pre-order stack itself — no parent-id string
    ///            (the one place v2 carried redundancy that v3 drops).
    ///   Delta:   baseHash + bases (chain segment, anchor first) + nodeCount +
    ///            fingerprint + removed refs + added/changed patch nodes
    ///            (patch flavor: explicit parent ref, no childCount).
    ///
    /// A "changed" node (delta) re-encodes its whole tracked payload, so a
    /// moved element (new parent) and a rect-changed element are the same
    /// primitive. Sorted keys everywhere a Dictionary is serialized — the
    /// byte output is a pure function of the snapshot content (regression
    /// fixtures can pin it).
    /// </summary>
    public static class UISnapshotBinaryWriter
    {
        /// <summary>ASCII "MDS\n" — magic the viewers sniff before any format logic.</summary>
        public static readonly byte[] Magic = { (byte)'M', (byte)'D', (byte)'S', (byte)'\n' };

        public const byte FormatVersion = 3;
        public const byte SchemaVersion = 3;

        public const byte FlagsContentModeDelta = 1 << 0; // bit0; 0 = anchor/full
        public const byte FlagsThemeInline = 1 << 2;

        /// <summary>Serialized bytes for a full (anchor) snapshot; themeMode 0/1/2 per the Theme section. Null snapshot → null.</summary>
        public static byte[] writeAnchor(UISnapshot snapshot, ThemeMode themeMode, uint themeHash, SnapshotTheme inlineTheme = null)
        {
            if (snapshot == null)
            {
                return null;
            }

            var writer = new MdsWriter();
            writer.Header(0, themeMode == ThemeMode.Inline ? FlagsThemeInline : (byte)0);
            WriteThemeSection(writer, themeMode, themeHash, inlineTheme);

            writer.StringRef(snapshot.timestampUtc);
            WriteApp(writer, snapshot.app);
            WriteView(writer, snapshot.view);
            writer.StringRef(snapshot.source);

            WriteNodes(writer, snapshot.nodes);

            return writer.Finish();
        }

        /// <summary>
        /// Serialized bytes for a delta capture (ADR-0009): the app/view/theme/source
        /// head rides along from <paramref name="head"/> (the fresh capture the diff was
        /// computed *from*), the body carries only the sparse node diff plus the
        /// materialized tree count and fingerprint so the ledger stays honest.
        /// </summary>
        public static byte[] writeDelta(SnapshotDelta delta, UISnapshot head, ThemeMode themeMode, uint themeHash, SnapshotTheme inlineTheme = null)
        {
            if (delta == null || head == null)
            {
                return null;
            }

            var writer = new MdsWriter();
            writer.Header(FlagsContentModeDelta, themeMode == ThemeMode.Inline ? FlagsThemeInline : (byte)0);
            WriteThemeSection(writer, themeMode, themeHash, inlineTheme);

            writer.StringRef(head.timestampUtc);
            WriteApp(writer, head.app);
            WriteView(writer, head.view);
            writer.StringRef(head.source);

            // Delta body. Chain identity first: self-contained resolution goes
            // anchor → bases[1..] → this file's diffs (the ADR's materialization
            // order), never needing the ledger to walk.
            writer.InlineString(delta.baseHash);
            writer.VarUint((ulong)(delta.bases?.Count ?? 0));
            if (delta.bases != null)
            {
                foreach (var hash in delta.bases)
                {
                    writer.InlineString(hash);
                }
            }

            writer.VarUint((ulong)delta.nodeCount);
            writer.VarUint(delta.fingerprint);

            writer.VarUint((ulong)(delta.removedIds?.Count ?? 0));
            if (delta.removedIds != null)
            {
                foreach (var id in delta.removedIds)
                {
                    writer.StringRef(id);
                }
            }

            writer.VarUint((ulong)(delta.added?.Count ?? 0));
            if (delta.added != null)
            {
                foreach (var node in delta.added)
                {
                    WritePatchNode(writer, node);
                }
            }

            writer.VarUint((ulong)(delta.changed?.Count ?? 0));
            if (delta.changed != null)
            {
                foreach (var node in delta.changed)
                {
                    WritePatchNode(writer, node);
                }
            }

            return writer.Finish();
        }

        /// <summary>Theme section mode as carried in the file.</summary>
        public enum ThemeMode : byte
        {
            /// <summary>No theme at all (settings never initialized).</summary>
            Absent = 0,
            /// <summary>Full SnapshotTheme inline (standalone/hotkey captures outside a session context — ADR-0007 point 4).</summary>
            Inline = 1,
            /// <summary>Manifest hash ref — the session-scoped manifest (ADR-0007 points 1-2) carries the content.</summary>
            ManifestRef = 2,
        }

        /** -------------------------------------------------------- sections */

        /// <summary>
        /// Manifest artifact bytes (ADR-0007 point 2): the same "MDS" v3 container
        /// whose body is a list of (hash, inline-theme) entries. The viewer's loader
        /// resolves themeHash → manifest → theme with this one primitive set.
        /// </summary>
        public static byte[] writeManifest(IReadOnlyList<(uint hash, SnapshotTheme theme)> entries)
        {
            if (entries == null)
            {
                return null;
            }

            var writer = new MdsWriter();
            writer.Header(0, 0);
            writer.VarUint((ulong)entries.Count);
            foreach (var (hash, theme) in entries)
            {
                writer.InlineString(FnvHex(hash));
                // Present flag (0/1) then the inline theme payload — the absent
                // case cannot occur through the store, but the encoding keeps
                // the decoder total.
                writer.VarUint(theme == null ? 0u : 1u);
                if (theme != null)
                {
                    WriteThemeContent(writer, theme);
                }
            }
            return writer.Finish();
        }

        private static void WriteThemeSection(MdsWriter writer, ThemeMode themeMode, uint themeHash, SnapshotTheme inlineTheme)
        {
            writer.VarUint((uint)themeMode);
            switch (themeMode)
            {
                case ThemeMode.ManifestRef:
                    // The hash hex travels inline (it is a session-level join key,
                    // not node data); same "x8" form the builder's fingerprint
                    // uses — one hash formatting everywhere.
                    writer.InlineString(FnvHex(themeHash));
                    break;

                case ThemeMode.Inline:
                    WriteThemeContent(writer, inlineTheme);
                    break;

                case ThemeMode.Absent:
                    break; // mode value only
            }
        }

        /// <summary>The full SnapshotTheme payload — shared by snapshot files (inline fallback) and the manifest (ADR-0007).</summary>
        private static void WriteThemeContent(MdsWriter writer, SnapshotTheme theme)
        {
            if (theme == null)
            {
                // Inline demanded but no theme captured (settings null):
                // degrade to the absent encoding rather than corrupt bytes.
                writer.VarUint((uint)ThemeMode.Absent);
                return;
            }

            var bools = theme.isDark ? 1u : 0u;
            writer.VarUint(bools);
            writer.StringRef(theme.seedColor);
            writer.StringRef(theme.deviceType);
            writer.VarUint((ulong)(theme.palette?.Count ?? 0));
            foreach (var pair in SortedStringsAndValues(theme.palette))
            {
                writer.StringRef(pair.Key);
                writer.StringRef(pair.Value);
            }
            writer.VarUint((ulong)(theme.spacing?.Count ?? 0));
            if (theme.spacing != null)
            {
                foreach (var pair in SortedFloats(theme.spacing))
                {
                    writer.StringRef(pair.Key);
                    writer.VarBytesI32(Quantize(pair.Value));
                }
            }
            writer.VarUint((ulong)(theme.sizing?.Count ?? 0));
            if (theme.sizing != null)
            {
                foreach (var pair in SortedFloats(theme.sizing))
                {
                    writer.StringRef(pair.Key);
                    writer.VarBytesI32(Quantize(pair.Value));
                }
            }
            writer.VarUint((ulong)(theme.typography?.Count ?? 0));
            if (theme.typography != null)
            {
                var roleKeys = new List<string>(theme.typography.Keys);
                roleKeys.Sort(System.StringComparer.Ordinal);
                foreach (var roleKey in roleKeys)
                {
                    var style = theme.typography[roleKey] ?? new SnapshotTextStyle();
                    writer.StringRef(roleKey);
                    writer.VarBytesI32(Quantize(style.fontSize));
                    writer.StringRef(style.fontWeight);
                    writer.StringRef(style.fontStyle);
                    writer.StringRef(style.fontName);
                    writer.VarBytesI32(Quantize(style.characterSpacing));
                    writer.VarBytesI32(Quantize(style.lineSpacing));
                }
            }
        }

        private static List<KeyValuePair<string, float>> SortedFloats(Dictionary<string, float> map)
        {
            var pairs = new List<KeyValuePair<string, float>>(map.Count);
            foreach (var pair in map)
            {
                pairs.Add(pair);
            }
            pairs.Sort((a, b) => System.StringComparer.Ordinal.Compare(a.Key, b.Key));
            return pairs;
        }

        internal static string FnvHex(uint hash)
        {
            return hash.ToString("x8", CultureInfo.InvariantCulture);
        }

        private static void WriteApp(MdsWriter writer, SnapshotAppInfo app)
        {
            if (app == null)
            {
                writer.VarUint(0);
                return;
            }

            writer.VarUint(1);
            writer.StringRef(app.productName);
            writer.StringRef(app.productVersion);
            writer.StringRef(app.unityVersion);
            writer.StringRef(app.platform);
            writer.StringRef(app.deviceType);
            writer.StringRef(app.sessionId);
            writer.VarBytesI32(Int(app.screenWidth));
            writer.VarBytesI32(Int(app.screenHeight));
            writer.VarBytesI32(Int(app.scaleFactor));
        }

        private static void WriteView(MdsWriter writer, SnapshotViewInfo view)
        {
            if (view == null)
            {
                writer.VarUint(0);
                return;
            }

            writer.VarUint(1);
            writer.StringRef(view.id);
            writer.StringRef(view.name);
            writer.StringRef(view.type);
            writer.StringRef(view.layer);
        }

        /// <summary>Anchor flavor: pre-order columnar-leaning stream, hierarchy carried by childCount (the stack).</summary>
        private static void WriteNodes(MdsWriter writer, List<SnapshotNode> nodes)
        {
            writer.VarUint((ulong)(nodes?.Count ?? 0));
            if (nodes == null)
            {
                return;
            }

            foreach (var node in nodes)
            {
                writer.VarUint((ulong)(node.children?.Count ?? 0));
                WriteNodeBody(writer, node);
            }
        }

        /// <summary>Delta patch flavor: explicit parent — the chain may move a node to a new one.</summary>
        private static void WritePatchNode(MdsWriter writer, SnapshotNode node)
        {
            writer.StringRef(node.id);
            writer.StringRef(node.parentId);
            WriteNodeBody(writer, node);
        }

        // info-bitset positions (see the file comment) — shared by both flavors.
        private const int InfoKindLayout = 0;
        private const int InfoIsView = 1;
        private const int InfoActive = 2;
        private const int InfoHasRect = 3;
        private const int InfoHasRectLocal = 4;
        private const int InfoHasAnchor = 5;
        private const int InfoHasLayout = 6;
        private const int InfoHasLayoutElement = 7;
        private const int InfoHasContentSizeFitter = 8;
        private const int InfoHasData = 9;
        private const int InfoHasResolved = 10;
        private const int InfoHasError = 11;
        private const int InfoHasLayer = 12;

        private static void WriteNodeBody(MdsWriter writer, SnapshotNode node)
        {
            var info = 0u;
            if (node.kind == "layout") { info |= 1u << InfoKindLayout; }
            if (node.isView) { info |= 1u << InfoIsView; }
            if (node.active) { info |= 1u << InfoActive; }
            if (node.rect != null) { info |= 1u << InfoHasRect; }
            if (node.rectLocal != null) { info |= 1u << InfoHasRectLocal; }
            if (node.anchor != null) { info |= 1u << InfoHasAnchor; }
            if (node.layout != null) { info |= 1u << InfoHasLayout; }
            if (node.layoutElement != null) { info |= 1u << InfoHasLayoutElement; }
            if (node.contentSizeFitter != null) { info |= 1u << InfoHasContentSizeFitter; }
            if (node.data != null && node.data.Count > 0) { info |= 1u << InfoHasData; }
            if (node.resolved != null) { info |= 1u << InfoHasResolved; }
            if (!string.IsNullOrEmpty(node.error)) { info |= 1u << InfoHasError; }
            if (!string.IsNullOrEmpty(node.layer)) { info |= 1u << InfoHasLayer; }

            writer.VarUint(info);
            writer.VarBytesI32(node.siblingIndex);
            writer.StringRef(node.id);
            writer.StringRef(node.name);
            writer.StringRef(node.type);

            if ((info & (1u << InfoHasLayer)) != 0) { writer.StringRef(node.layer); }
            if ((info & (1u << InfoHasRect)) != 0) { WriteRect(writer, node.rect); }
            if ((info & (1u << InfoHasRectLocal)) != 0) { WriteRect(writer, node.rectLocal); }
            if ((info & (1u << InfoHasAnchor)) != 0) { WriteAnchor(writer, node.anchor); }

            if ((info & (1u << InfoHasLayout)) != 0)
            {
                var layout = node.layout;
                var bools = 0u;
                if (layout.runtimeSwitchable) { bools |= 1u; }
                if (layout.controlChildWidth) { bools |= 1u << 1; }
                if (layout.controlChildHeight) { bools |= 1u << 2; }
                if (layout.childForceExpandWidth) { bools |= 1u << 3; }
                if (layout.childForceExpandHeight) { bools |= 1u << 4; }
                if (layout.reverseArrangement) { bools |= 1u << 5; }
                writer.StringRef(layout.type);
                writer.VarUint(bools);
                writer.VarBytesI32(Int(layout.paddingLeft));
                writer.VarBytesI32(Int(layout.paddingRight));
                writer.VarBytesI32(Int(layout.paddingTop));
                writer.VarBytesI32(Int(layout.paddingBottom));
                writer.VarBytesI32(Int(layout.spacing));
                writer.StringRef(layout.childAlignment);
            }

            if ((info & (1u << InfoHasLayoutElement)) != 0)
            {
                var le = node.layoutElement;
                writer.VarBytesI32(Int(le.minWidth));
                writer.VarBytesI32(Int(le.minHeight));
                writer.VarBytesI32(Int(le.preferredWidth));
                writer.VarBytesI32(Int(le.preferredHeight));
                writer.VarBytesI32(Int(le.flexibleWidth));
                writer.VarBytesI32(Int(le.flexibleHeight));
                writer.VarUint(le.ignoreLayout ? 1u : 0u);
            }

            if ((info & (1u << InfoHasContentSizeFitter)) != 0)
            {
                writer.StringRef(node.contentSizeFitter.horizontalMode);
                writer.StringRef(node.contentSizeFitter.verticalMode);
            }

            if ((info & (1u << InfoHasData)) != 0)
            {
                WriteData(writer, node.data);
            }

            if ((info & (1u << InfoHasResolved)) != 0)
            {
                WriteResolved(writer, node.resolved);
            }

            if ((info & (1u << InfoHasError)) != 0)
            {
                writer.StringRef(node.error);
            }
        }

        private static void WriteRect(MdsWriter writer, SnapshotRect rect)
        {
            writer.VarBytesI32(Int(rect.x));
            writer.VarBytesI32(Int(rect.y));
            writer.VarBytesI32(Int(rect.width));
            writer.VarBytesI32(Int(rect.height));
        }

        private static void WriteAnchor(MdsWriter writer, SnapshotAnchor anchor)
        {
            writer.VarBytesI32(Int(anchor.pivotX));
            writer.VarBytesI32(Int(anchor.pivotY));
            writer.VarBytesI32(Int(anchor.anchorMinX));
            writer.VarBytesI32(Int(anchor.anchorMinY));
            writer.VarBytesI32(Int(anchor.anchorMaxX));
            writer.VarBytesI32(Int(anchor.anchorMaxY));
            writer.VarBytesI32(Int(anchor.anchoredX));
            writer.VarBytesI32(Int(anchor.anchoredY));
            writer.VarBytesI32(Int(anchor.sizeX));
            writer.VarBytesI32(Int(anchor.sizeY));
        }

        // data sub-value kind tags (see the file comment).
        private const byte DataKindNull = 0;
        private const byte DataKindBool = 1;
        private const byte DataKindInt = 2;
        private const byte DataKindFloat = 3;
        private const byte DataKindString = 4;
        private const byte DataKindList = 5;
        private const byte DataKindMap = 6;
        private const byte DataKindSymbol = 7;

        private static void WriteData(MdsWriter writer, Dictionary<string, object> data)
        {
            // Sorted for byte-determinism (Dictionary order is otherwise an
            // implementation detail); the reader keeps a JS object — key order
            // is not part of the render contract for data maps either way.
            var keys = new List<string>(data.Keys);
            keys.Sort(System.StringComparer.Ordinal);
            writer.VarUint((ulong)keys.Count);
            foreach (var key in keys)
            {
                writer.StringRef(key);
                WriteDataValue(writer, data[key]);
            }
        }

        private static void WriteDataValue(MdsWriter writer, object value)
        {
            switch (value)
            {
                case null:
                    writer.VarUint(DataKindNull);
                    return;
                case bool b:
                    writer.VarUint(DataKindBool);
                    writer.VarUint(b ? 1u : 0u);
                    return;
                case int i:
                    writer.VarUint(DataKindInt);
                    writer.VarBytesI32(i);
                    return;
                case long l:
                    writer.VarUint(DataKindInt);
                    writer.VarBytesI32((int)l);
                    return;
                case short s:
                    writer.VarUint(DataKindInt);
                    writer.VarBytesI32(s);
                    return;
                case byte by:
                    writer.VarUint(DataKindInt);
                    writer.VarBytesI32(by);
                    return;
                case double d:
                    writer.VarUint(DataKindFloat);
                    writer.VarBytesI32(Quantize((float)d));
                    return;
                case float f:
                    writer.VarUint(DataKindFloat);
                    writer.VarBytesI32(Quantize(f));
                    return;
                case decimal m:
                    writer.VarUint(DataKindFloat);
                    writer.VarBytesI32(Quantize((float)m));
                    return;
                case Dictionary<string, object> map:
                    writer.VarUint(DataKindMap);
                    writer.VarUint((ulong)map.Count);
                    foreach (var pair in Sorted(map))
                    {
                        // Nested-struct field names recur across nodes of the
                        // same struct — interned like everything else.
                        writer.StringRef(pair.Key);
                        WriteDataValue(writer, pair.Value);
                    }
                    return;
                case List<object> list:
                    writer.VarUint(DataKindList);
                    writer.VarUint((ulong)list.Count);
                    foreach (var element in list)
                    {
                        WriteDataValue(writer, element);
                    }
                    return;
                default:
                    // Everything else the YAML path produced as a string
                    // (enum names, hex colors, char, struct ToString) —
                    // interned, because those strings are exactly the
                    // token-identity redundancy the table exists to collapse.
                    writer.VarUint(DataKindString);
                    writer.StringRef(value.ToString());
                    return;
            }
        }

        private static List<KeyValuePair<string, object>> Sorted(Dictionary<string, object> map)
        {
            var pairs = new List<KeyValuePair<string, object>>(map.Count);
            foreach (var pair in map)
            {
                pairs.Add(pair);
            }
            pairs.Sort((a, b) => System.StringComparer.Ordinal.Compare(a.Key, b.Key));
            return pairs;
        }

        // resolved presence-mask positions (field order below must match).
        private const int ResolvedColorRoles = 0;
        private const int ResolvedTextRole = 1;
        private const int ResolvedText = 2;
        private const int ResolvedFontSize = 3;
        private const int ResolvedFontWeight = 4;
        private const int ResolvedFontName = 5;
        private const int ResolvedTextWidth = 6;
        private const int ResolvedColor = 7;
        private const int ResolvedBackgroundColor = 8;
        private const int ResolvedFillColor = 9;
        private const int ResolvedOutlineColor = 10;
        private const int ResolvedOutlineWidth = 11;
        private const int ResolvedOpacity = 12;
        private const int ResolvedCornerRadius = 13;

        private static void WriteResolved(MdsWriter writer, SnapshotResolved resolved)
        {
            var mask = 0u;
            if (resolved.colorRoles != null && resolved.colorRoles.Count > 0) { mask |= 1u << ResolvedColorRoles; }
            if (resolved.textRole != null) { mask |= 1u << ResolvedTextRole; }
            if (resolved.text != null) { mask |= 1u << ResolvedText; }
            if (resolved.fontSize.HasValue) { mask |= 1u << ResolvedFontSize; }
            if (resolved.fontWeight != null) { mask |= 1u << ResolvedFontWeight; }
            if (resolved.fontName != null) { mask |= 1u << ResolvedFontName; }
            if (resolved.textWidth.HasValue) { mask |= 1u << ResolvedTextWidth; }
            if (resolved.color != null) { mask |= 1u << ResolvedColor; }
            if (resolved.backgroundColor != null) { mask |= 1u << ResolvedBackgroundColor; }
            if (resolved.fillColor != null) { mask |= 1u << ResolvedFillColor; }
            if (resolved.outlineColor != null) { mask |= 1u << ResolvedOutlineColor; }
            if (resolved.outlineWidth.HasValue) { mask |= 1u << ResolvedOutlineWidth; }
            if (resolved.opacity.HasValue) { mask |= 1u << ResolvedOpacity; }
            if (resolved.cornerRadius.HasValue) { mask |= 1u << ResolvedCornerRadius; }

            writer.VarUint(mask);

            if ((mask & (1u << ResolvedColorRoles)) != 0)
            {
                var roles = resolved.colorRoles;
                writer.VarUint((ulong)roles.Count);
                foreach (var pair in SortedStringsAndValues(roles))
                {
                    writer.StringRef(pair.Key);
                    writer.StringRef(pair.Value);
                }
            }
            if ((mask & (1u << ResolvedTextRole)) != 0) { writer.StringRef(resolved.textRole); }
            if ((mask & (1u << ResolvedText)) != 0) { writer.StringRef(resolved.text); }
            if ((mask & (1u << ResolvedFontSize)) != 0) { writer.VarBytesI32(Quantize(resolved.fontSize.Value)); }
            if ((mask & (1u << ResolvedFontWeight)) != 0) { writer.StringRef(resolved.fontWeight); }
            if ((mask & (1u << ResolvedFontName)) != 0) { writer.StringRef(resolved.fontName); }
            if ((mask & (1u << ResolvedTextWidth)) != 0) { writer.VarBytesI32(Quantize(resolved.textWidth.Value)); }
            if ((mask & (1u << ResolvedColor)) != 0) { writer.StringRef(resolved.color); }
            if ((mask & (1u << ResolvedBackgroundColor)) != 0) { writer.StringRef(resolved.backgroundColor); }
            if ((mask & (1u << ResolvedFillColor)) != 0) { writer.StringRef(resolved.fillColor); }
            if ((mask & (1u << ResolvedOutlineColor)) != 0) { writer.StringRef(resolved.outlineColor); }
            if ((mask & (1u << ResolvedOutlineWidth)) != 0) { writer.VarBytesI32(Quantize(resolved.outlineWidth.Value)); }
            if ((mask & (1u << ResolvedOpacity)) != 0) { writer.VarBytesI32(Quantize(resolved.opacity.Value)); }
            if ((mask & (1u << ResolvedCornerRadius)) != 0) { writer.VarBytesI32(Quantize(resolved.cornerRadius.Value)); }
        }

        private static List<KeyValuePair<string, string>> SortedStringsAndValues(Dictionary<string, string> map)
        {
            var pairs = new List<KeyValuePair<string, string>>(map.Count);
            foreach (var pair in map)
            {
                pairs.Add(pair);
            }
            pairs.Sort((a, b) => System.StringComparer.Ordinal.Compare(a.Key, b.Key));
            return pairs;
        }

        /// <summary>0.01 quantization — the precision <see cref="UISnapshotBuilder"/> round() serializes at.</summary>
        internal static int Quantize(float value)
        {
            if (float.IsNaN(value))
            {
                return 0;
            }

            var scaled = value * 100f;
            if (scaled >= 2147483000f) return int.MaxValue;
            if (scaled <= -2147483000f) return int.MinValue;
            return Mathf.RoundToInt(scaled);
        }

        private static int Int(float value) => Quantize(value);

        /** ----------------------------------------------------- byte plumbing */

        /// <summary>
        /// The whole serializer state: payload buffered first (which interns
        /// strings in first-use order), then the header and the string table are
        /// emitted ahead of the payload at Finish() — the table must precede the
        /// payload on the wire, but its content is only knowable after walking.
        /// </summary>
        private sealed class MdsWriter
        {
            private readonly MemoryStream _payload = new MemoryStream();
            private readonly BinaryWriter _payloadWriter;
            private readonly List<string> _strings = new List<string>();
            private readonly Dictionary<string, int> _stringIndex = new Dictionary<string, int>();
            private readonly byte[] _header = new byte[7];

            public MdsWriter()
            {
                _payloadWriter = new BinaryWriter(_payload);
            }

            public void Header(byte flags1, byte flags2)
            {
                _header[0] = Magic[0];
                _header[1] = Magic[1];
                _header[2] = Magic[2];
                _header[3] = Magic[3];
                _header[4] = FormatVersion;
                _header[5] = SchemaVersion;
                _header[6] = (byte)(flags1 | flags2);
            }

            public void VarUint(ulong value)
            {
                while (true)
                {
                    if (value < 0x80u)
                    {
                        _payload.WriteByte((byte)value);
                        return;
                    }
                    _payload.WriteByte((byte)(value | 0x80u));
                    value >>= 7;
                }
            }

            public void VarBytesI32(int value) => VarUint(Zigzag(value));

            public void StringRef(string value)
            {
                if (value == null)
                {
                    VarUint(0);
                    return;
                }
                if (!_stringIndex.TryGetValue(value, out var index))
                {
                    index = _strings.Count;
                    _stringIndex[value] = index;
                    _strings.Add(value);
                }
                VarUint((ulong)(index + 1));
            }

            /// <summary>Length-prefixed UTF-8 straight into the payload (not interned) — used for the theme-ref hash and chain hashes only.</summary>
            public void InlineString(string value)
            {
                value ??= "";
                var bytes = Encoding.UTF8.GetBytes(value);
                VarUint((ulong)bytes.Length);
                _payload.Write(bytes, 0, bytes.Length);
            }

            public byte[] Finish()
            {
                var outStream = new MemoryStream(_strings.Count * 12 + (int)_payload.Length + 16);
                outStream.Write(_header, 0, _header.Length);

                VarUintInto(outStream, (ulong)_strings.Count);
                foreach (var entry in _strings)
                {
                    var bytes = Encoding.UTF8.GetBytes(entry);
                    VarUintInto(outStream, (ulong)bytes.Length);
                    outStream.Write(bytes, 0, bytes.Length);
                }

                _payload.Seek(0, SeekOrigin.Begin);
                _payload.CopyTo(outStream);
                return outStream.ToArray();
            }

            private static void VarUintInto(Stream stream, ulong value)
            {
                while (true)
                {
                    if (value < 0x80u)
                    {
                        stream.WriteByte((byte)value);
                        return;
                    }
                    stream.WriteByte((byte)(value | 0x80u));
                    value >>= 7;
                }
            }

            private static ulong Zigzag(int value)
            {
                return (ulong)((uint)((value << 1) ^ (value >> 31)));
            }
        }
    }
}
