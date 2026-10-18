using System;
using System.Collections.Generic;
using mdu.ui;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Pool;
using UnityEngine.SceneManagement;

namespace mdu.editor.ui
{
    [InitializeOnLoad]
    public static class UniqueIdWatcher
    {
        private static bool _isProcessing;

        static UniqueIdWatcher()
        {
            ObjectChangeEvents.changesPublished -= onChanges;
            ObjectChangeEvents.changesPublished += onChanges;
        }

        private static void onChanges(ref ObjectChangeEventStream stream)
        {
            if (_isProcessing)
            {
                return;
            }

            try
            {
                _isProcessing = true;

                using (ListPool<GameObject>.Get(out var createdObjects))
                {
                    collectCreatedObjects(ref stream, createdObjects);

                    if (createdObjects.Count == 0)
                    {
                        return;
                    }

                    processCreatedObjects(createdObjects);
                }
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
            finally
            {
                _isProcessing = false;
            }
        }

        private static void collectCreatedObjects(ref ObjectChangeEventStream stream, List<GameObject> createdObjects)
        {
            for (int i = 0; i < stream.length; i++)
            {
                ObjectChangeKind kind = stream.GetEventType(i);

                if (kind == ObjectChangeKind.CreateGameObjectHierarchy)
                {
                    stream.GetCreateGameObjectHierarchyEvent(i, out CreateGameObjectHierarchyEventArgs args);

                    if (args.scene.IsValid() && EditorUtility.InstanceIDToObject(args.instanceId) is GameObject gameObject)
                    {
                        createdObjects.Add(gameObject);
                    }
                }
                else if (kind == ObjectChangeKind.CreateAssetObject)
                {
                    stream.GetCreateAssetObjectEvent(i, out CreateAssetObjectEventArgs args);

                    if (EditorUtility.InstanceIDToObject(args.instanceId) is GameObject assetRoot)
                    {
                        createdObjects.Add(assetRoot);
                    }
                }
            }
        }

        private static void processCreatedObjects(List<GameObject> createdObjects)
        {
            using (HashSetPool<IUI>.Get(out var batch))
            using (ListPool<IUI>.Get(out var buffer))
            {
                foreach (GameObject gameObject in createdObjects)
                {
                    buffer.Clear();
                    gameObject.GetComponentsInChildren(true, buffer);
                    batch.UnionWith(buffer);
                }

                if (batch.Count == 0)
                {
                    return;
                }

                using (HashSetPool<string>.Get(out var takenIds))
                {
                    collectTakenIds(batch, takenIds);

                    foreach (IUI element in batch)
                    {
                        if (element is not Component component || component == null)
                        {
                            continue;
                        }

                        if (PrefabUtility.IsPartOfPrefabAsset(component.gameObject) || PrefabStageUtility.GetPrefabStage(component.gameObject) != null)
                        {
                            if (!string.IsNullOrEmpty(element.id))
                            {
                                setId(component, string.Empty);
                            }

                            continue;
                        }

                        ensureSceneId(element, component, takenIds);
                    }
                }
            }
        }

        private static void collectTakenIds(HashSet<IUI> batch, HashSet<string> takenIds)
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);

                if (!scene.isLoaded)
                {
                    continue;
                }

                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    foreach (IUI element in root.GetComponentsInChildren<IUI>(true))
                    {
                        if (!batch.Contains(element) && !string.IsNullOrEmpty(element.id))
                        {
                            takenIds.Add(element.id);
                        }
                    }
                }
            }
        }

        private static void ensureSceneId(IUI element, Component component, HashSet<string> takenIds)
        {
            string id = element.id;

            if (string.IsNullOrEmpty(id))
            {
                return;
            }

            if (takenIds.Add(id))
            {
                return;
            }

            string newId = Guid.NewGuid().ToString("N");
            setId(component, newId);
            takenIds.Add(newId);
        }

        private static void setId(Component component, string id)
        {
            using (var serializedObject = new SerializedObject(component))
            {
                SerializedProperty property = serializedObject.FindProperty("_id");

                if (property == null)
                {
                    Debug.LogWarning($"UI element '{component}' has no serialized '_id' property.");
                    return;
                }

                property.stringValue = id;
                serializedObject.ApplyModifiedPropertiesWithoutUndo();
            }
        }
    }
}
