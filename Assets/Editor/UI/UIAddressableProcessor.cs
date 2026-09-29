using UnityEditor;
using UnityEditor.AddressableAssets;
using UnityEditor.AddressableAssets.Settings;
using UnityEngine;
using System.Linq;

namespace mdu.editor.ui
{
    using mdu.ui;

    public class UIAddressableProcessor : AssetPostprocessor
    {
        private static void OnPostprocessAllAssets(string[] importedAssets, string[] deletedAssets, string[] movedAssets, string[] movedFromAssetPaths)
        {
            // We are interested in prefab changes
            if (importedAssets.Any(path => path.EndsWith(".prefab")) || movedAssets.Any(path => path.EndsWith(".prefab")))
            {
                ProcessAllUIViews();
            }
        }

        [MenuItem("Darwins Tower/Tools/Process All UI Views and Components for Addressables")]
        private static void ProcessAllUIViews()
        {
            var settings = AddressableAssetSettingsDefaultObject.GetSettings(true);
            if (settings == null)
            {
                Debug.LogError("Addressable Asset Settings not found. Please initialize Addressables first.");
                return;
            }

            string[] prefabGuids = AssetDatabase.FindAssets("t:Prefab");
            foreach (string guid in prefabGuids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);

                if (prefab != null)
                {
                    var view = prefab.GetComponent<IView>();
                    var component = prefab.GetComponent<IUIComponent>();
                    if (view != null)
                    {
                        AddressableAssetEntry entry = settings.CreateOrMoveEntry(guid, settings.DefaultGroup);
                        entry.SetAddress(view.GetType().FullName);
                        entry.SetLabel("UIView", true);
                    }
                    else if (component != null)
                    {
                        AddressableAssetEntry entry = settings.CreateOrMoveEntry(guid, settings.DefaultGroup);
                        entry.SetAddress(component.GetType().FullName);
                        entry.SetLabel("UIComponent", true);
                    }
                }
            }
        }
    }
}