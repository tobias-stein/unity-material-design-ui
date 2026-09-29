using System;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct WindowFrameData
    {
        public string title;
        public bool fullscreen;
        public UnityEvent onClose;
    }

    public class WindowFrame : UIComponent<WindowFrame, WindowFrameData>
    {
        [SerializeField] private SDFQuad _background;
        [SerializeField] private AppBar _appBar;
        [SerializeField] private ContentSizeFitter _contentSizeFiter;

        public override void setupUI(UISettings uISettings)
        {
            _background.fillColor = uISettings.getColor(UISettings.ColorRole.Surface);
            _background.gradationColor = uISettings.getColor(UISettings.ColorRole.SurfaceBright);
            _background.shadowColor = uISettings.getColor(UISettings.ColorRole.Shadow);

            binder.bind(data => data.title, value => _appBar.binder.updateField(data => data.title, value));
            binder.bind(data => data.fullscreen, value =>
            {
                if (value) // fullscreen
                {
                    _contentSizeFiter.enabled = false;
                    rectTransform.anchorMin = Vector2.zero;
                    rectTransform.anchorMax = Vector2.one;
                    rectTransform.sizeDelta = Vector2.zero;
                    _background.radius = 0.0f;
                }
                else
                {
                    _contentSizeFiter.enabled = true;
                    rectTransform.anchorMin = rectTransform.anchorMax = new Vector2(0.5f, 0.5f);
                    _background.radius = 8.0f;
                }

                LayoutRebuilder.ForceRebuildLayoutImmediate(rectTransform);
            });
            binder.bind(data => data.onClose, value => _appBar.binder.updateField(data => data.onBack, value));
        }
    }
}