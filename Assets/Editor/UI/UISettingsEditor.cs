using UnityEditor;
using UnityEngine;

namespace mdu.ui.editor
{
    [CustomEditor(typeof(UISettings))]
    public class UISettingsEditor : Editor
    {
        private SerializedProperty breakpoints;
        private SerializedProperty useDarkTheme;
        private SerializedProperty colors;
        private SerializedProperty typography;
        private SerializedProperty spacesSizes;
        private SerializedProperty defaultDeviceType;

        private bool showColors = true;
        private bool showTypography = true;
        private bool showSpacesSizes = true;

        private void OnEnable()
        {
            breakpoints = serializedObject.FindProperty("_breakpoints");
            useDarkTheme = serializedObject.FindProperty("_useDarkTheme");
            colors = serializedObject.FindProperty("_colors");
            typography = serializedObject.FindProperty("_typography");
            spacesSizes = serializedObject.FindProperty("_spacesSizes");
            defaultDeviceType = serializedObject.FindProperty("_defaultDeviceType");
        }

        public override void OnInspectorGUI()
        {
            serializedObject.Update();

            EditorGUILayout.PropertyField(breakpoints);
            EditorGUILayout.PropertyField(useDarkTheme);
            EditorGUILayout.PropertyField(defaultDeviceType);

            EditorGUILayout.Space();

            // Colors Foldout
            EditorGUILayout.ObjectField(colors);
            showColors = EditorGUILayout.Foldout(showColors, "Color Theme", true);
            if (showColors && colors.objectReferenceValue != null)
            {
                EditorGUI.indentLevel++;
                EditorGUILayout.PropertyField(colors);
                var colorTheme = (ColorTheme)colors.objectReferenceValue;
                if (GUILayout.Button("Generate Colors"))
                {
                    colorTheme.Generate();
                }
                Editor.CreateCachedEditor(colorTheme, null, ref _colorEditor);
                _colorEditor.OnInspectorGUI();
                EditorGUI.indentLevel--;
            }

            EditorGUILayout.Space();

            // Typography Foldout
            EditorGUILayout.ObjectField(typography);
            showTypography = EditorGUILayout.Foldout(showTypography, "Typography Theme", true);
            if (showTypography && typography.objectReferenceValue != null)
            {
                EditorGUI.indentLevel++;
                EditorGUILayout.PropertyField(typography);
                var typographyTheme = (TypographyTheme)typography.objectReferenceValue;
                Editor.CreateCachedEditor(typographyTheme, null, ref _typographyEditor);
                _typographyEditor.OnInspectorGUI();
                EditorGUI.indentLevel--;
            }

            EditorGUILayout.Space();

            // Spaces and Sizes Foldout
            EditorGUILayout.ObjectField(spacesSizes);
            showSpacesSizes = EditorGUILayout.Foldout(showSpacesSizes, "Space and Size Theme", true);
            if (showSpacesSizes && spacesSizes.objectReferenceValue != null)
            {
                EditorGUI.indentLevel++;
                EditorGUILayout.PropertyField(spacesSizes);
                var spaceSizeTheme = (SpaceSizeTheme)spacesSizes.objectReferenceValue;
                Editor.CreateCachedEditor(spaceSizeTheme, null, ref _spaceSizeEditor);
                _spaceSizeEditor.OnInspectorGUI();
                EditorGUI.indentLevel--;
            }

            serializedObject.ApplyModifiedProperties();
        }

        private Editor _colorEditor;
        private Editor _typographyEditor;
        private Editor _spaceSizeEditor;
    }
}