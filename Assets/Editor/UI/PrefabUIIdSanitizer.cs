using System;
using System.Collections.Generic;
using mdu.ui;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Pool;

namespace mdu.editor.ui
{
    /// <summary>
    /// Prefab assets must never carry serialized UI ids: every instantiated clone
    /// receives a fresh id at runtime (see UI.assignRuntimeIds).
    ///
    /// <see cref="UniqueIdWatcher"/> cannot cover ids written to disk by "Save As",
    /// dragging a prefab instance into the Project window, or duplicating an asset:
    /// ObjectChangeEvents only reports undoable in-memory changes, and
    /// ObjectChangeKind.CreateAssetObject explicitly excludes on-disk assets.
    ///
    /// Note: AssetPostprocessor.OnPostprocessPrefab cannot be used here — it edits
    /// the imported (Library) prefab, not the source asset. This pass rewrites the
    /// source prefab after import instead, and only when it actually contains ids.
    /// </summary>
    public sealed class PrefabUIIdSanitizer : AssetPostprocessor
    {
        private static readonly HashSet<string> _pending = new HashSet<string>();
        private static bool _scheduled;
        private static bool _isProcessing;

        private static void OnPostprocessAllAssets(
            string[] importedAssets,
            string[] deletedAssets,
            string[] movedAssets,
            string[] movedFromAssetPaths,
            bool didDomainReload)
        {
            // Changes made by SaveAsPrefabAsset re-enter this callback; the asset is
            // already clean by then, so ignoring the re-entrant pass is safe.
            if (_isProcessing)
            {
                return;
            }

            var added = collectPrefabs(importedAssets);
            added |= collectPrefabs(movedAssets);

            if (!added || _scheduled)
            {
                return;
            }

            _scheduled = true;
            EditorApplication.delayCall += processPending;
        }

        private static bool collectPrefabs(string[] paths)
        {
            var added = false;
            if (paths == null)
            {
                return false;
            }

            foreach (var path in paths)
            {
                if (path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) &&
                    path.StartsWith("Assets/", StringComparison.Ordinal))
                {
                    _pending.Add(path);
                    added = true;
                }
            }

            return added;
        }

        private static void processPending()
        {
            _scheduled = false;
            if (_isProcessing || _pending.Count == 0)
            {
                return;
            }

            _isProcessing = true;
            try
            {
                var paths = new List<string>(_pending);
                _pending.Clear();

                foreach (var path in paths)
                {
                    try
                    {
                        clearPrefabAsset(path);
                    }
                    catch (Exception ex)
                    {
                        Debug.LogException(ex);
                    }
                }
            }
            finally
            {
                _isProcessing = false;
            }
        }

        [MenuItem("Tools/mdu/Clear UI IDs in Prefab Assets")]
        private static void clearAllPrefabIds()
        {
            var guids = AssetDatabase.FindAssets("t:Prefab");
            var cleared = 0;

            try
            {
                for (var i = 0; i < guids.Length; i++)
                {
                    var path = AssetDatabase.GUIDToAssetPath(guids[i]);
                    if (!path.StartsWith("Assets/", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (EditorUtility.DisplayCancelableProgressBar(
                            "Clearing UI IDs",
                            path,
                            (float)i / Mathf.Max(1, guids.Length)))
                    {
                        break;
                    }

                    if (clearPrefabAsset(path))
                    {
                        cleared++;
                    }
                }
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }

            Debug.Log($"Cleared UI ids in {cleared} prefab asset(s).");
        }

        private static bool clearPrefabAsset(string path)
        {
            if (string.IsNullOrEmpty(path) || !path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var asset = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (asset == null || PrefabUtility.GetPrefabAssetType(asset) != PrefabAssetType.Regular)
            {
                // Variants inherit their base prefab's (now empty) ids; leave their
                // structure untouched. Models are not authored prefabs.
                return false;
            }

            // Editing the prefab contents while its stage is open fights the user's
            // in-progress edits. The next import after the stage closes will clean it.
            var stage = PrefabStageUtility.GetCurrentPrefabStage();
            if (stage != null && string.Equals(stage.assetPath, path, StringComparison.Ordinal))
            {
                return false;
            }

            var root = PrefabUtility.LoadPrefabContents(path);
            if (root == null)
            {
                return false;
            }

            var changed = false;
            try
            {
                using (ListPool<IUI>.Get(out var elements))
                {
                    root.GetComponentsInChildren<IUI>(true, elements);
                    foreach (var element in elements)
                    {
                        if (!string.IsNullOrEmpty(element.id))
                        {
                            element.clearPrefabId();
                            changed = true;
                        }
                    }
                }

                if (changed)
                {
                    PrefabUtility.SaveAsPrefabAsset(root, path);
                }
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(root);
            }

            return changed;
        }
    }
}
