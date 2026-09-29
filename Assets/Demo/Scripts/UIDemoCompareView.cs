using System;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Events;

namespace mdu.ui.demo
{
    [Serializable]
    public struct UIDemoCompareViewData
    {
    }


    [RequireComponent(typeof(StackPanelContainer))]
    public class UIDemoCompareView : UIView<UIDemoCompareView, UIDemoCompareViewData>
    {
        private StackPanelContainer _panelContainer;

        private UIDemoComparePanel _firstPanel;

        private const int MAX_PANELS = 7;
        public async void Awake()
        {
            var onClick = new UnityEvent();
            onClick.AddListener(openCompare);
            
            _panelContainer = GetComponent<StackPanelContainer>();
            // create initial first panel
            _firstPanel = await UIDemoComparePanel.create(rectTransform, new UIDemoComparePanelData
            {
                title = $"Panel #{(int)(UnityEngine.Random.value * 1000)}",
                closable = false,
                comparable = true,
                onCompare = onClick
            }).ContinueWith(panel =>
            {
                _panelContainer.addPanel(panel);
                return panel;
            });
        }

        private void openCompare()
        {
            var onClick = new UnityEvent();
            onClick.AddListener(openCompare);
            
            //_firstPanel.binder.updateField(data => data.comparable, _panelContainer.numPanels + 1 < MAX_PANELS);
            UIDemoComparePanel.create(rectTransform, new UIDemoComparePanelData
            {
                title = $"Panel #{(int)(UnityEngine.Random.value * 1000)}",
                closable = true,
                comparable = true,
                onCompare = onClick
            }).ContinueWith(panel =>
            {
                _panelContainer.addPanel(panel);

                panel.onClosed += _ =>
                {
                    _firstPanel.binder.updateField(data => data.comparable, _panelContainer.numPanels < MAX_PANELS);
                };

            }).Forget();  
        }

        public override void setupUI(UISettings uISettings)
        {
            _panelContainer = GetComponent<StackPanelContainer>();
        }
    }
}
