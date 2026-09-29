using mdu.ui;
using UnityEditor;

namespace mdu.ui.editor
{
    [CustomEditor(typeof(UIDebug))]
    public class UIDebugEditor : Editor
    {
        private SerializedProperty uiSettingsProperty;
        private Editor uiSettingsEditor;

        private void OnEnable()
        {
            // Cache the SerializedProperty for the uISettings field
            uiSettingsProperty = serializedObject.FindProperty("uISettings");
        }

        public override void OnInspectorGUI()
        {
            // Update the serializedObject to reflect the latest state of the target object
            serializedObject.Update();

            // Draw the object field for assigning the UISettings ScriptableObject
            EditorGUILayout.PropertyField(uiSettingsProperty);

            // Check if a UISettings object is assigned
            if (uiSettingsProperty.objectReferenceValue != null)
            {
                // Add a little space and a separator for visual clarity
                EditorGUILayout.Space();
                EditorGUILayout.Separator();

                // Create a cached editor for the assigned UISettings object.
                // This will use the custom UISettingsEditor you created earlier.
                Editor.CreateCachedEditor(uiSettingsProperty.objectReferenceValue, null, ref uiSettingsEditor);

                // If the editor was successfully created, draw it
                if (uiSettingsEditor != null)
                {
                    uiSettingsEditor.OnInspectorGUI();
                }
            }

            // Apply any changes made in the inspector to the serializedObject
            serializedObject.ApplyModifiedProperties();
        }

        private void OnDisable()
        {
            // Clean up the cached editor when the UIDebug inspector is closed or loses focus
            if (uiSettingsEditor != null)
            {
                DestroyImmediate(uiSettingsEditor);
            }
        }
    }
}