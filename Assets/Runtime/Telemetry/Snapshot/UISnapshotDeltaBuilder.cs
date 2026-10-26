using System.Collections.Generic;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Builds the ADR-0009 delta between a chain state (the last exported materialized
    /// tree of a view's open cycle) and the freshly walked tree of a mutation capture.
    /// The diff is structural-identity based — the same identity fields the mutation
    /// fingerprint uses, extended to the full tracked payload (rects, layout state,
    /// resolved visuals, data dump) because the *storage* contract is "the materialized
    /// replay equals the export nobody can distinguish from a full capture".
    ///
    /// What the ADR calls the "materialized post-delta tree" is by construction
    /// exactly the fresh capture itself (the diff was computed against it), so the
    /// dedupe fingerprint stays valid unchanged: a delta that resolves to an
    /// identical tree still dedupes, no bypass exists.
    /// </summary>
    public static class UISnapshotDeltaBuilder
    {
        /// <summary>
        /// Loops over two whole-but-same-shaped node lists and emits the sparse diff.
        /// O(n) over the fresh capture's nodes with a map lookup per node — the
        /// cost is the serialization-free comparison the ADR trades the O(n)
        /// *serialization* against; the walk itself stays the full O(n) one
        /// (rects cannot be diffed without computing them — see the ADR's gate note).
        /// </summary>
        public static SnapshotDelta build(SnapshotChainState chain, UISnapshot next, uint fingerprintOfNext)
        {
            var delta = new SnapshotDelta
            {
                baseHash = chain.lastHash,
                bases = new List<string>(chain.bases) { chain.lastHash },
                nodeCount = next.nodes?.Count ?? 0,
                fingerprint = fingerprintOfNext,
                removedIds = new List<string>(),
                added = new List<SnapshotNode>(),
                changed = new List<SnapshotNode>()
            };

            var baseById = new Dictionary<string, SnapshotNode>();
            var nextById = new Dictionary<string, SnapshotNode>();
            addIds(baseById, chain.materialized?.nodes);
            addIds(nextById, next?.nodes);

            foreach (var pair in baseById)
            {
                if (!nextById.TryGetValue(pair.Key, out var nextNode))
                {
                    delta.removedIds.Add(pair.Key);
                    continue;
                }
                if (!samePayload(pair.Value, nextNode))
                {
                    delta.changed.Add(nextNode);
                }
            }

            foreach (var pair in nextById)
            {
                if (!baseById.ContainsKey(pair.Key))
                {
                    delta.added.Add(pair.Value);
                }
            }

            return delta;
        }

        private static void addIds(Dictionary<string, SnapshotNode> into, List<SnapshotNode> nodes)
        {
            if (nodes == null)
            {
                return;
            }
            foreach (var node in nodes)
            {
                if (node?.id == null)
                {
                    continue;
                }
                into[node.id] = node; // ids are unique per walk (builder enforces); last wins defensively
            }
        }

        private static bool samePayload(SnapshotNode a, SnapshotNode b)
        {
            if (a == null || b == null) { return a == b; }
            return a.id == b.id
                && a.parentId == b.parentId
                && a.siblingIndex == b.siblingIndex
                && a.kind == b.kind
                && a.name == b.name
                && a.type == b.type
                && a.active == b.active
                && a.isView == b.isView
                && a.layer == b.layer
                && sameRect(a.rect, b.rect)
                && sameRect(a.rectLocal, b.rectLocal)
                && sameAnchor(a.anchor, b.anchor)
                && sameLayout(a.layout, b.layout)
                && sameLayoutElement(a.layoutElement, b.layoutElement)
                && sameFitter(a.contentSizeFitter, b.contentSizeFitter)
                && sameData(a.data, b.data)
                && sameResolved(a.resolved, b.resolved)
                && a.error == b.error;
        }

        /// <summary>Quantized comparison at the exact storage precision — float wobble below 0.01 never fabricates a delta.</summary>
        private static bool sameRect(SnapshotRect a, SnapshotRect b)
        {
            if (a == null || b == null) { return a == b; }
            return Quant(a.x) == Quant(b.x)
                && Quant(a.y) == Quant(b.y)
                && Quant(a.width) == Quant(b.width)
                && Quant(a.height) == Quant(b.height);
        }

        private static bool sameAnchor(SnapshotAnchor a, SnapshotAnchor b)
        {
            if (a == null || b == null) { return a == b; }
            return Quant(a.pivotX) == Quant(b.pivotX)
                && Quant(a.pivotY) == Quant(b.pivotY)
                && Quant(a.anchorMinX) == Quant(b.anchorMinX)
                && Quant(a.anchorMinY) == Quant(b.anchorMinY)
                && Quant(a.anchorMaxX) == Quant(b.anchorMaxX)
                && Quant(a.anchorMaxY) == Quant(b.anchorMaxY)
                && Quant(a.anchoredX) == Quant(b.anchoredX)
                && Quant(a.anchoredY) == Quant(b.anchoredY)
                && Quant(a.sizeX) == Quant(b.sizeX)
                && Quant(a.sizeY) == Quant(b.sizeY);
        }

        private static bool sameLayout(SnapshotLayout a, SnapshotLayout b)
        {
            if (a == null || b == null) { return a == b; }
            return a.type == b.type
                && a.runtimeSwitchable == b.runtimeSwitchable
                && Quant(a.paddingLeft) == Quant(b.paddingLeft)
                && Quant(a.paddingRight) == Quant(b.paddingRight)
                && Quant(a.paddingTop) == Quant(b.paddingTop)
                && Quant(a.paddingBottom) == Quant(b.paddingBottom)
                && Quant(a.spacing) == Quant(b.spacing)
                && a.childAlignment == b.childAlignment
                && a.controlChildWidth == b.controlChildWidth
                && a.controlChildHeight == b.controlChildHeight
                && a.childForceExpandWidth == b.childForceExpandWidth
                && a.childForceExpandHeight == b.childForceExpandHeight
                && a.reverseArrangement == b.reverseArrangement;
        }

        private static bool sameLayoutElement(SnapshotLayoutElement a, SnapshotLayoutElement b)
        {
            if (a == null || b == null) { return a == b; }
            return Quant(a.minWidth) == Quant(b.minWidth)
                && Quant(a.minHeight) == Quant(b.minHeight)
                && Quant(a.preferredWidth) == Quant(b.preferredWidth)
                && Quant(a.preferredHeight) == Quant(b.preferredHeight)
                && Quant(a.flexibleWidth) == Quant(b.flexibleWidth)
                && Quant(a.flexibleHeight) == Quant(b.flexibleHeight)
                && a.ignoreLayout == b.ignoreLayout;
        }

        private static bool sameFitter(SnapshotContentSizeFitter a, SnapshotContentSizeFitter b)
        {
            if (a == null || b == null) { return a == b; }
            return a.horizontalMode == b.horizontalMode && a.verticalMode == b.verticalMode;
        }

        private static bool sameData(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            if (a == null || a.Count == 0) { return b == null || b.Count == 0; }
            if (b == null || a.Count != b.Count) { return false; }
            foreach (var pair in a)
            {
                if (!b.TryGetValue(pair.Key, out var bValue) || !samePlain(pair.Value, bValue))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool sameResolved(SnapshotResolved a, SnapshotResolved b)
        {
            if (a == null) { return b == null || isDefault(b); }
            if (b == null) { return isDefault(a); }

            if (!sameMap(a.colorRoles, b.colorRoles))
            {
                return false;
            }
            return a.textRole == b.textRole
                && a.text == b.text
                && sameFloat(a.fontSize, b.fontSize)
                && a.fontWeight == b.fontWeight
                && a.fontName == b.fontName
                && sameFloat(a.textWidth, b.textWidth)
                && a.color == b.color
                && a.backgroundColor == b.backgroundColor
                && a.fillColor == b.fillColor
                && a.outlineColor == b.outlineColor
                && sameFloat(a.outlineWidth, b.outlineWidth)
                && sameFloat(a.opacity, b.opacity)
                && sameFloat(a.cornerRadius, b.cornerRadius);
        }

        private static bool isDefault(SnapshotResolved resolved)
        {
            return resolved.colorRoles == null
                && resolved.textRole == null
                && resolved.text == null
                && !resolved.fontSize.HasValue
                && resolved.fontWeight == null
                && resolved.fontName == null
                && !resolved.textWidth.HasValue
                && resolved.color == null
                && resolved.backgroundColor == null
                && resolved.fillColor == null
                && resolved.outlineColor == null
                && !resolved.outlineWidth.HasValue
                && !resolved.opacity.HasValue
                && !resolved.cornerRadius.HasValue;
        }

        private static bool sameFloat(float? a, float? b)
        {
            if (a.HasValue != b.HasValue) { return false; }
            return !a.HasValue || Quant(a.Value) == Quant(b.Value);
        }

        /// <summary>Deep equality over the toPlain object graphs the data convention produces.</summary>
        private static bool samePlain(object a, object b)
        {
            if (a is Dictionary<string, object> aMap && b is Dictionary<string, object> bMap)
            {
                if (aMap.Count != bMap.Count) { return false; }
                foreach (var pair in aMap)
                {
                    if (!bMap.TryGetValue(pair.Key, out var bValue) || !samePlain(pair.Value, bValue))
                    {
                        return false;
                    }
                }
                return true;
            }

            if (a is List<object> aList && b is List<object> bList)
            {
                if (aList.Count != bList.Count) { return false; }
                for (var i = 0; i < aList.Count; i++)
                {
                    if (!samePlain(aList[i], bList[i])) { return false; }
                }
                return true;
            }

            if (a is float || a is double || a is int || a is long)
            {
                return QuantPlain(a) == QuantPlain(b);
            }

            return Equals(a, b);
        }

        private static int QuantPlain(object value)
        {
            return value switch
            {
                float f => Quant(f),
                double d => Quant((float)d),
                int i => Quant(i),
                long l => Quant(l),
                short s => Quant(s),
                byte by => Quant(by),
                _ => 0
            };
        }

        private static int Quant(float value) => UISnapshotBinaryWriter.Quantize(value);

        /// <summary>Map-of-strings equality (colorRoles) at identity level.</summary>
        private static bool sameMap(Dictionary<string, string> a, Dictionary<string, string> b)
        {
            var aEmpty = a == null || a.Count == 0;
            var bEmpty = b == null || b.Count == 0;
            if (aEmpty && bEmpty) { return true; }
            if (aEmpty != bEmpty || a.Count != b.Count) { return false; }
            foreach (var pair in a)
            {
                if (!b.TryGetValue(pair.Key, out var bValue) || pair.Value != bValue)
                {
                    return false;
                }
            }
            return true;
        }
    }
}
