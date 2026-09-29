using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    public struct SeperatorData
    {

    }

    public class Seperator : UIComponent<Seperator, SeperatorData>
    {
        [SerializeField] private Image _image;

        public override void setupUI(UISettings uISettings)
        {
            _image?.applyColor(uISettings, UISettings.ColorRole.OutlineVariant);
        }
    }
}