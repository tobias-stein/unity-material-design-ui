using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using com.convalise.UnityMaterialSymbols;
using TLab.UI.SDF;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Builds a <see cref="UISnapshot"/> from a live UI subtree (default: the active view).
    /// Capture is a synchronous, single-pass O(n) walk of the RectTransform hierarchy.
    /// Every transform becomes a node; failures degrade to a node carrying an
    /// <see cref="SnapshotNode.error"/> instead of aborting the export.
    /// </summary>
    public static class UISnapshotBuilder
    {
        private static readonly Dictionary<Type, MemberInfo> _binderMembers = new Dictionary<Type, MemberInfo>();
        private static readonly Vector3[] _cornerBuffer = new Vector3[4];

        /// <summary>Below this alpha an SDF paint is considered not rendered (clear fills used for outline-only shapes).</summary>
        private const float MIN_VISIBLE_ALPHA = 0.01f;

        /// <summary>
        /// Captures <paramref name="root"/> (default: current active view) plus theme/app info.
        /// Returns null (with a warning) when there is nothing to capture.
        /// </summary>
        public static UISnapshot build(IUI root = null)
        {
            root ??= UI.views?.currentContext?.mainView;
            if (root == null || root.rectTransform == null)
            {
                Debug.LogWarning("[Telemetry] snapshot skipped: no active view.");
                return null;
            }

            if (Telemetry.config.forceRebuildLayout)
            {
                // ForceRebuildLayoutImmediate on the view root is a no-op (Unity skips
                // subtrees whose root has no ILayoutController), so flush the canvas
                // queues and rebuild the real layout roots instead.
                UILayout.forceNow(root.rectTransform);
            }

            var snapshot = new UISnapshot
            {
                schemaVersion = UISnapshot.SCHEMA_VERSION,
                timestampUtc = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                app = buildAppInfo(root),
                view = buildViewInfo(root),
                theme = buildTheme(),
                nodes = new List<SnapshotNode>()
            };

            var takenIds = new HashSet<string>();
            walk(root.rectTransform, null, 0, root, snapshot, takenIds);
            return snapshot;
        }

        private static SnapshotAppInfo buildAppInfo(IUI root)
        {
            var settings = UI.settings;
            var canvas = root.rectTransform.GetComponentInParent<Canvas>();
            return new SnapshotAppInfo
            {
                productName = Application.productName,
                productVersion = Application.version,
                unityVersion = Application.unityVersion,
                platform = Application.platform.ToString(),
                deviceType = settings != null ? settings.CurrentDeviceType.ToString() : null,
                screenWidth = round(Screen.width),
                screenHeight = round(Screen.height),
                scaleFactor = round(canvas != null ? canvas.scaleFactor : 1f)
            };
        }

        private static SnapshotViewInfo buildViewInfo(IUI root)
        {
            return new SnapshotViewInfo
            {
                id = string.IsNullOrEmpty(root.id) ? null : root.id,
                name = cleanName(root.rectTransform.name),
                type = friendlyTypeName(root.GetType()),
                layer = root is IView view ? view.layer.ToString() : null
            };
        }

        private static SnapshotTheme buildTheme()
        {
            var settings = UI.settings;
            if (settings == null)
            {
                return null;
            }

            var theme = new SnapshotTheme
            {
                seedColor = toHex(settings.seedColor),
                isDark = settings.useDarkTheme,
                deviceType = settings.CurrentDeviceType.ToString(),
                palette = new Dictionary<string, string>(),
                spacing = new Dictionary<string, float>(),
                sizing = new Dictionary<string, float>(),
                typography = new Dictionary<string, SnapshotTextStyle>()
            };

            foreach (UISettings.ColorRole role in Enum.GetValues(typeof(UISettings.ColorRole)))
            {
                if (role == UISettings.ColorRole.Customized) { continue; } // not a real palette entry
                theme.palette[role.ToString()] = toHex(settings.getColor(role));
            }

            foreach (UISettings.Spacing spacing in Enum.GetValues(typeof(UISettings.Spacing)))
            {
                theme.spacing[spacing.ToString()] = round(settings.GetSpacingInUnityUnits(spacing));
            }

            foreach (UISettings.Sizing sizing in Enum.GetValues(typeof(UISettings.Sizing)))
            {
                theme.sizing[sizing.ToString()] = round(settings.GetSizeInUnityUnits(sizing));
            }

            foreach (UISettings.TextRole role in Enum.GetValues(typeof(UISettings.TextRole)))
            {
                var style = settings.getTextStyle(role);
                theme.typography[role.ToString()] = new SnapshotTextStyle
                {
                    fontSize = round(style.fontSize),
                    fontWeight = style.fontWeight.ToString(),
                    fontStyle = style.fontStyle.ToString(),
                    fontName = style.font != null ? style.font.name : null,
                    characterSpacing = round(style.characterSpacing),
                    lineSpacing = round(style.lineSpacing)
                };
            }

            return theme;
        }

        private static string walk(RectTransform rect, string parentId, int siblingIndex, IUI root, UISnapshot snapshot, HashSet<string> takenIds)
        {
            if (rect == null)
            {
                return null;
            }

            var iui = rect.GetComponent<IUI>();
            if (iui != null && iui.isPooled && Telemetry.config.skipPooled)
            {
                return null;
            }

            var node = new SnapshotNode
            {
                parentId = parentId,
                siblingIndex = siblingIndex,
                children = new List<string>()
            };
            snapshot.nodes.Add(node);

            try
            {
                fillNode(node, rect, iui, root, takenIds);
            }
            catch (Exception ex)
            {
                node.error = ex.Message;
                Debug.LogException(ex);
            }

            for (int i = 0; i < rect.childCount; i++)
            {
                var child = rect.GetChild(i) as RectTransform;
                if (child == null) { continue; }
                var childId = walk(child, node.id, child.GetSiblingIndex(), root, snapshot, takenIds);
                if (childId != null)
                {
                    node.children.Add(childId);
                }
            }

            return node.id;
        }

        private static void fillNode(SnapshotNode node, RectTransform rect, IUI iui, IUI root, HashSet<string> takenIds)
        {
            var go = rect.gameObject;

            node.id = resolveId(iui, node.parentId, node.siblingIndex, takenIds);
            node.kind = iui != null ? "ui" : "layout";
            node.name = go.name;
            node.type = iui != null ? friendlyTypeName(iui.GetType()) : "UnityEngine.RectTransform";
            node.active = go.activeInHierarchy;
            node.rect = rectRootRelative(rect, root.rectTransform);
            node.rectLocal = rectLocal(rect);
            node.anchor = anchorOf(rect);

            if (iui is IView view)
            {
                node.isView = true;
                node.layer = view.layer.ToString();
            }

            if (iui != null)
            {
                fillLayout(rect, node);
                fillDataAndRoles(iui, node);
            }

            fillResolved(go, node);
        }

        private static string resolveId(IUI iui, string parentId, int siblingIndex, HashSet<string> takenIds)
        {
            var id = iui?.id;
            if (string.IsNullOrEmpty(id))
            {
                return $"anon:{parentId ?? "root"}/{siblingIndex}";
            }

            if (!takenIds.Add(id))
            {
                // Defensive: ids are globally unique at runtime, but a snapshot must
                // never contain duplicates (the viewer indexes by id).
                var fallback = $"{id}#{takenIds.Count}";
                takenIds.Add(fallback);
                return fallback;
            }

            return id;
        }

        private static void fillLayout(RectTransform rect, SnapshotNode node)
        {
            var go = rect.gameObject;

            var group = go.GetComponent<LayoutGroup>();
            if (group != null)
            {
                var layout = new SnapshotLayout
                {
                    paddingLeft = round(group.padding.left),
                    paddingRight = round(group.padding.right),
                    paddingTop = round(group.padding.top),
                    paddingBottom = round(group.padding.bottom),
                    childAlignment = group.childAlignment.ToString()
                };

                if (group is HorizontalOrVerticalLayoutGroup hv)
                {
                    layout.spacing = round(hv.spacing);
                    layout.controlChildWidth = hv.childControlWidth;
                    layout.controlChildHeight = hv.childControlHeight;
                    layout.childForceExpandWidth = hv.childForceExpandWidth;
                    layout.childForceExpandHeight = hv.childForceExpandHeight;
                    layout.reverseArrangement = hv.reverseArrangement;

                    if (hv is VerticalLayoutGroup)
                    {
                        layout.type = "Vertical";
                    }
                    else if (hv is HVLayoutGroup hvlg)
                    {
                        layout.type = hvlg.IsVertical ? "Vertical" : "Horizontal";
                        layout.runtimeSwitchable = true;
                    }
                    else
                    {
                        layout.type = "Horizontal";
                    }
                }
                else
                {
                    layout.type = "Custom";
                }

                node.layout = layout;
            }

            var layoutElement = go.GetComponent<LayoutElement>();
            if (layoutElement != null)
            {
                node.layoutElement = new SnapshotLayoutElement
                {
                    minWidth = round(layoutElement.minWidth),
                    minHeight = round(layoutElement.minHeight),
                    preferredWidth = round(layoutElement.preferredWidth),
                    preferredHeight = round(layoutElement.preferredHeight),
                    flexibleWidth = round(layoutElement.flexibleWidth),
                    flexibleHeight = round(layoutElement.flexibleHeight),
                    ignoreLayout = layoutElement.ignoreLayout
                };
            }

            var fitter = go.GetComponent<ContentSizeFitter>();
            if (fitter != null)
            {
                node.contentSizeFitter = new SnapshotContentSizeFitter
                {
                    horizontalMode = fitter.horizontalFit.ToString(),
                    verticalMode = fitter.verticalFit.ToString()
                };
            }
        }

        private static void fillDataAndRoles(IUI iui, SnapshotNode node)
        {
            var boxed = getBinderData(iui);
            if (boxed == null)
            {
                return;
            }

            var dataType = boxed.GetType();
            Dictionary<string, string> colorRoles = null;
            string textRole = null;

            var fields = dataType.GetFields(BindingFlags.Public | BindingFlags.Instance);
            if (fields.Length > 0)
            {
                node.data = new Dictionary<string, object>();
                foreach (var field in fields)
                {
                    object value;
                    try { value = field.GetValue(boxed); }
                    catch { continue; }

                    if (field.FieldType == typeof(UISettings.ColorRole))
                    {
                        colorRoles ??= new Dictionary<string, string>();
                        colorRoles[field.Name] = value?.ToString();
                    }
                    else if (field.FieldType == typeof(UISettings.TextRole) && textRole == null && value != null)
                    {
                        textRole = value.ToString();
                    }

                    var plain = toPlain(value, 3);
                    if (plain != null)
                    {
                        node.data[field.Name] = plain;
                    }
                }
            }
            else
            {
                // Data structs are expected to use public fields; fall back to public
                // properties so a future refactor doesn't silently drop state.
                var properties = dataType.GetProperties(BindingFlags.Public | BindingFlags.Instance);
                node.data = new Dictionary<string, object>();
                foreach (var property in properties)
                {
                    if (!property.CanRead || property.GetIndexParameters().Length > 0) { continue; }
                    object value;
                    try { value = property.GetValue(boxed); }
                    catch { continue; }
                    var plain = toPlain(value, 3);
                    if (plain != null)
                    {
                        node.data[property.Name] = plain;
                    }
                    if (property.PropertyType == typeof(UISettings.ColorRole))
                    {
                        colorRoles ??= new Dictionary<string, string>();
                        colorRoles[property.Name] = value?.ToString();
                    }
                    else if (property.PropertyType == typeof(UISettings.TextRole) && textRole == null && value != null)
                    {
                        textRole = value.ToString();
                    }
                }
            }

            if (colorRoles != null || textRole != null)
            {
                node.resolved ??= new SnapshotResolved();
                node.resolved.colorRoles = colorRoles;
                node.resolved.textRole = textRole;
            }
        }

        private static void fillResolved(GameObject go, SnapshotNode node)
        {
            var resolved = node.resolved ??= new SnapshotResolved();
            bool any = false;

            var tmp = go.GetComponent<TMP_Text>();
            if (tmp != null)
            {
                resolved.text = tmp.text;
                resolved.fontSize = round(tmp.fontSize);
                // The baked SDF style is what actually renders (an empty fontWeightTable
                // makes Unity fall back to the base Regular regardless of the requested
                // tmp.fontWeight), so capture faceInfo.styleName — not tmp.fontWeight.
                resolved.fontWeight = tmp.font != null && !string.IsNullOrEmpty(tmp.font.faceInfo.styleName)
                    ? tmp.font.faceInfo.styleName
                    : null;
                resolved.fontName = tmp.font != null ? tmp.font.name : null;
                // Unity's own single-line text measurement. The viewer uses it to
                // decide whether Unity actually ellipsized (rect narrower than the
                // measured text) — browser-font metric drift must not clip text
                // that Unity rendered in full.
                resolved.textWidth = round(tmp.preferredWidth);
                // canvasRenderer color included: Selectable/CrossFade tints land there, not on Graphic.color
                resolved.color = toHex(tmp.color * tmp.canvasRenderer.GetColor());
                any = true;
            }

            var image = go.GetComponent<Image>();
            if (image != null)
            {
                resolved.backgroundColor = toHex(image.color * image.canvasRenderer.GetColor());
                any = true;
            }

            var canvasGroup = go.GetComponent<CanvasGroup>();
            if (canvasGroup != null)
            {
                resolved.opacity = round(canvasGroup.alpha);
                any = true;
            }

            var sdf = go.GetComponent<SDFQuad>();
            if (sdf != null)
            {
                resolved.cornerRadius = round(sdf.radius);
                fillSdfColors(sdf, resolved);
                any = true;
            }

            var circle = go.GetComponent<SDFCircle>();
            if (circle != null)
            {
                fillSdfColors(circle, resolved);
                any = true;
            }

            if (!any)
            {
                node.resolved = resolved.colorRoles != null || resolved.textRole != null ? resolved : null;
            }
        }

        /// <summary>
        /// Effective SDF container paint. The rendered color is the product of
        /// three layers:
        ///  - <see cref="SDFUI.fillColor"/> / <see cref="SDFUI.outlineColor"/>
        ///    (material color),
        ///  - <see cref="Graphic.color"/> (mesh vertex tint),
        ///  - <see cref="CanvasRenderer.GetColor"/> — where Selectable.ColorTint
        ///    lands (Button's ColorBlock role color goes through CrossFadeColor,
        ///    which animates the CanvasRenderer and never touches Graphic.color).
        /// </summary>
        private static void fillSdfColors(SDFUI sdf, SnapshotResolved resolved)
        {
            var tint = sdf.color * sdf.canvasRenderer.GetColor();
            var fill = sdf.fillColor * tint;
            if (fill.a > MIN_VISIBLE_ALPHA)
            {
                resolved.fillColor = toHex(fill);
            }

            if (sdf.outline && sdf.outlineWidth > 0f)
            {
                resolved.outlineColor = toHex(sdf.outlineColor * tint);
                resolved.outlineWidth = round(sdf.outlineWidth);
            }
        }

        private static object getBinderData(IUI iui)
        {
            var type = iui.GetType();
            if (!_binderMembers.TryGetValue(type, out var member))
            {
                var binderField = type.GetField("binder", BindingFlags.Public | BindingFlags.Instance);
                if (binderField != null)
                {
                    member = binderField;
                }
                else
                {
                    member = type.GetProperty("binder", BindingFlags.Public | BindingFlags.Instance);
                }
                _binderMembers[type] = member;
            }

            try
            {
                object binder;
                if (member is FieldInfo field)
                {
                    binder = field.GetValue(iui);
                }
                else if (member is PropertyInfo property)
                {
                    binder = property.GetValue(iui);
                }
                else
                {
                    return null;
                }

                return binder?.GetType().GetProperty("data")?.GetValue(binder);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return null;
            }
        }

        /// <summary>
        /// Converts arbitrary *Data struct values into plain YAML-friendly objects:
        /// primitives, enum names, hex colors, float arrays for vectors,
        /// {code, fill} for MaterialSymbolData; UnityEvents/objects are reduced
        /// to null (skipped) or a name. Depth-limited recursion for nested structs.
        /// </summary>
        private static object toPlain(object value, int depth)
        {
            if (value == null)
            {
                return null;
            }

            switch (value)
            {
                case string s: return s;
                case bool b: return b;
                case int i: return i;
                case long l: return l;
                case short sh: return sh;
                case byte by: return by;
                case double d: return round((float)d);
                case float f: return round(f);
                case decimal m: return (double)m;
                case char c: return c.ToString();
                case Enum: return value.ToString();
                case Color color: return toHex(color);
                case Color32 color32: return toHex(color32);
                case Vector2 v2: return new List<object> { round(v2.x), round(v2.y) };
                case Vector3 v3: return new List<object> { round(v3.x), round(v3.y), round(v3.z) };
                case Vector4 v4: return new List<object> { round(v4.x), round(v4.y), round(v4.z), round(v4.w) };
                case MaterialSymbolData symbol:
                    return new Dictionary<string, object> { { "code", (int)symbol.code }, { "fill", symbol.fill } };
                case UnityEngine.Events.UnityEventBase: return null;
                case Delegate: return null;
                case UnityEngine.Object unityObject: return unityObject.name;
            }

            if (depth <= 0)
            {
                return value.ToString();
            }

            if (value is IEnumerable enumerable and not string)
            {
                var list = new List<object>();
                foreach (var element in enumerable)
                {
                    list.Add(toPlain(element, depth - 1));
                }
                return list;
            }

            var type = value.GetType();
            if (type.IsClass || type.IsValueType)
            {
                var map = new Dictionary<string, object>();
                foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
                {
                    object fieldValue;
                    try { fieldValue = field.GetValue(value); }
                    catch { continue; }
                    var plain = toPlain(fieldValue, depth - 1);
                    if (plain != null)
                    {
                        map[field.Name] = plain;
                    }
                }
                if (map.Count > 0)
                {
                    return map;
                }
            }

            return value.ToString();
        }

        private static SnapshotRect rectRootRelative(RectTransform rect, RectTransform root)
        {
            rect.GetWorldCorners(_cornerBuffer);
            var rootRect = root.rect;

            float minU = float.MaxValue, maxU = float.MinValue;
            float minV = float.MaxValue, maxV = float.MinValue;

            for (int i = 0; i < 4; i++)
            {
                var p = root.InverseTransformPoint(_cornerBuffer[i]);
                if (p.x < minU) minU = p.x;
                if (p.x > maxU) maxU = p.x;
                if (p.y < minV) minV = p.y;
                if (p.y > maxV) maxV = p.y;
            }

            return new SnapshotRect
            {
                x = round(minU - rootRect.xMin),
                y = round(rootRect.yMax - maxV),
                width = round(maxU - minU),
                height = round(maxV - minV)
            };
        }

        private static SnapshotRect rectLocal(RectTransform rect)
        {
            var r = rect.rect;
            return new SnapshotRect
            {
                x = round(r.x),
                y = round(r.y),
                width = round(r.width),
                height = round(r.height)
            };
        }

        private static SnapshotAnchor anchorOf(RectTransform rect)
        {
            return new SnapshotAnchor
            {
                pivotX = round(rect.pivot.x),
                pivotY = round(rect.pivot.y),
                anchorMinX = round(rect.anchorMin.x),
                anchorMinY = round(rect.anchorMin.y),
                anchorMaxX = round(rect.anchorMax.x),
                anchorMaxY = round(rect.anchorMax.y),
                anchoredX = round(rect.anchoredPosition.x),
                anchoredY = round(rect.anchoredPosition.y),
                sizeX = round(rect.sizeDelta.x),
                sizeY = round(rect.sizeDelta.y)
            };
        }

        private static string friendlyTypeName(Type type)
        {
            var name = type.Name;
            var backtick = name.IndexOf('`');
            if (backtick >= 0)
            {
                name = name.Substring(0, backtick);
            }
            return string.IsNullOrEmpty(type.Namespace) ? name : $"{type.Namespace}.{name}";
        }

        private static string cleanName(string name)
        {
            const string cloneSuffix = " (Clone)";
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }
            return name.EndsWith(cloneSuffix, StringComparison.Ordinal)
                ? name.Substring(0, name.Length - cloneSuffix.Length)
                : name;
        }

        private static string toHex(Color color)
        {
            // "#RRGGBB[AA]" — the leading '#' is part of the schema so consumers
            // (the HTML snapshot viewer, log greps) can use the value as-is.
            return color.a >= 0.999f
                ? "#" + ColorUtility.ToHtmlStringRGB(color)
                : "#" + ColorUtility.ToHtmlStringRGBA(color);
        }

        private static float round(float value)
        {
            return Mathf.Round(value * 100f) / 100f;
        }
    }
}
