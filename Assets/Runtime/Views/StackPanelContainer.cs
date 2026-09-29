using System;
using System.Collections.Generic;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    public enum StackPanelOrentation
    {
        Horizontal,
        Vertical
    }

    public interface IStackPanel
    {
        Action<IStackPanel> onOpening { get; set; }
        Action<IStackPanel> onOpened { get; set; }
        Action<IStackPanel> onClosing { get; set; }
        Action<IStackPanel> onClosed { get; set; }
        Action<IStackPanel> onResize { get; set; }

        GameObject gameObject { get; }
        LayoutElement layoutElement { get; }

        void setOrientation(StackPanelOrentation newOrientation);

        UniTask animateOpen(float duration, bool scaleRelative);
        UniTask animateClose(float duration, bool scaleRelative);
    }

    public class StackPanelContainer : MonoBehaviour
    {
        public event Action<IStackPanel> onPanelRemoved;

        [SerializeField] private StackPanelOrentation orientation = StackPanelOrentation.Horizontal;

        private RectTransform panelContainer;

        private List<IStackPanel> panels = new List<IStackPanel>();

        private HorizontalOrVerticalLayoutGroup layoutGroup;

        [Range(0.0f, 3.0f)] public float animationDuration = 0.1f;

        public int numPanels => panels.Count;



        private void initialize()
        {
            var containerObject = new GameObject("PanelContainer");
            containerObject.transform.SetParent(transform, false);

            panelContainer = containerObject.AddComponent<RectTransform>();
            // stretched
            panelContainer.anchorMin = new Vector2(0, 0);
            panelContainer.anchorMax = new Vector2(1, 1);
            panelContainer.offsetMin = Vector2.zero;
            panelContainer.offsetMax = Vector2.zero;


            switch (orientation)
            {
                case StackPanelOrentation.Horizontal:
                    layoutGroup = containerObject.AddComponent<HorizontalLayoutGroup>();
                    layoutGroup.childForceExpandWidth = false;
                    layoutGroup.childForceExpandHeight = true;
                    layoutGroup.childControlWidth = true;
                    layoutGroup.childControlHeight = true;
                    break;
                case StackPanelOrentation.Vertical:
                    layoutGroup = containerObject.AddComponent<VerticalLayoutGroup>();
                    layoutGroup.childForceExpandWidth = true;
                    layoutGroup.childForceExpandHeight = false;
                    layoutGroup.childControlWidth = true;
                    layoutGroup.childControlHeight = true;
                    break;
            }
        }


        public void addPanel(IStackPanel panelInstance)
        {
            if(panelContainer == null)
            {
                initialize();
            }

            panelInstance.gameObject.transform.SetParent(panelContainer, false);

            panelInstance.setOrientation(orientation);
            panels.Add(panelInstance);

            panelInstance.onClosing += (panel) => removePanel(panel);
            panelInstance.onResize += (panel) => LayoutRebuilder.ForceRebuildLayoutImmediate(panelContainer);

            panelInstance.animateOpen(animationDuration, panels.Count > 1).Forget();
        }

        public void removePanel(IStackPanel panel) => removePanelAsync(panel).Forget();

        public async UniTaskVoid removePanelAsync(IStackPanel panel)
        {
            if (panels.Contains(panel))
            {
                panels.Remove(panel);
                onPanelRemoved?.Invoke(panel);

                await panel.animateClose(animationDuration, panels.Count > 0);
                Destroy(panel.gameObject);
            }
            else
            {
                Debug.LogWarning("Attempted to remove a panel that does not exist in the StackPanelView.");
            }
        }
    }
}
