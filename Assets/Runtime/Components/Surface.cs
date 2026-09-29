using System;
using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct SurfaceData
    {
        public UISettings.ColorRole colorRole;
        public Color customColor;

        [Range(0f, 1f)]
        public float opacity;
    }

    [RequireComponent(typeof(Image))]
    public class Surface : UIComponent<Surface, SurfaceData>
    {
        private Image _image;

        public new void Awake()
        {
            base.Awake();
            _image = GetComponent<Image>();
        }

        public override void setupUI(UISettings uiSettings)
        {
            _image = GetComponent<Image>();

            binder.bind(data => data.colorRole, value =>
            {
                // dependency
                var customColor = binder.data.customColor;
                var opacity = binder.data.opacity;

                _image.color = value != UISettings.ColorRole.Customized 
                    ? uiSettings.getColor(value).withAlpha(opacity)
                    : customColor;
            }, data => data.customColor, data => data.opacity);
        }
    }
}