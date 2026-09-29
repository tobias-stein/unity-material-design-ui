using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using mdu.ui;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Pool;
using UnityEngine.SceneManagement;

namespace mdu.editor.ui
{
    [InitializeOnLoad]
    public static class PrefabThemeWatcher
    {
        // Static constructor is called once when the editor loads.
        static PrefabThemeWatcher()
        {
            EditorApplication.delayCall += initialized;   
        }

        private static void initialized()
        {
            EditorApplication.delayCall -= initialized;
            
            UISettings.current.onChanged -= onUISettingsChanged;
            UISettings.current.onChanged += onUISettingsChanged;
            UISettings.current.OnValidate();
        }

        // This method is called whenever ANY ThemeSO invokes its OnThemeChanged event
        private static void onUISettingsChanged(UISettings uiSettings)
        {
            if(Application.isPlaying) { return; }
            try
            {
                updatePrefabStage(uiSettings);
                updateOpenScenes(uiSettings);
            }
            catch (Exception ex)
            {
                Debug.LogError(ex);
            }
        }

        private static void updatePrefabStage(UISettings uiSettings)
        {
            // Get the current open prefab stage
            var currentStage = PrefabStageUtility.GetCurrentPrefabStage();
            if (currentStage == null) return;

            IUI[] uis = currentStage.prefabContentsRoot.GetComponentsInChildren<IUI>(true);
            using (ListPool<IUI>.Get(out var buffer))
            {
                currentStage.prefabContentsRoot.GetComponentsInChildren<IUI>(true, buffer);
                buffer.Reverse(); // traverse UIs BOTTOM-UP
                foreach (var ui in buffer)
                {
                    ui.setupUI(uiSettings);
                    ui.refresh();
                }
            }
        }

        private static void updateOpenScenes(UISettings uiSettings)
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded)
                {
                    continue;
                }

                // Get all root GameObjects in the scene.
                using (ListPool<IUI>.Get(out var buffer))
                {
                    foreach (var root in scene.GetRootGameObjects())
                    {
                        buffer.Clear();
                        root.GetComponentsInChildren<IUI>(true, buffer);
                        buffer.Reverse(); // traverse UIs BOTTOM-UP
                        foreach (var ui in buffer)
                        {
                            ui.setupUI(uiSettings);
                            ui.refresh();
                        }
                    }
                }
            }
        }
    }    
}