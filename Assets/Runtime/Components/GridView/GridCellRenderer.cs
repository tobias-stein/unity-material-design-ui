using Cysharp.Threading.Tasks;
using UnityEngine;

namespace mdu.ui
{
    public interface IGridViewCellRenderer
    {
        UniTask<IUIComponent> renderAsync(GridViewCell cell, object value);
        void updateAsync(GridViewCell cell, object value, IUIComponent component);
    }


    public class DefaultGridViewCellHeaderRenderer : IGridViewCellRenderer
    {
        public async UniTask<IUIComponent> renderAsync(GridViewCell cell, object value)
        {
            return await Text.create(null, new TextData
            {
                text = value?.ToString() ?? "",
                opacity = 1.0f,
                textRole = UISettings.TextRole.LabelMedium,
                colorRole = cell.binder.data.showHighlight ? UISettings.ColorRole.OnPrimaryContainer : UISettings.ColorRole.OnSurface,
                verticalAlignment = TMPro.VerticalAlignmentOptions.Geometry,
                wrapping = TMPro.TextWrappingModes.NoWrap,
                overflow = TMPro.TextOverflowModes.Ellipsis
            },
            async instance => instance.rectTransform.sizeDelta = new Vector2(cell.binder.data.width, instance.rectTransform.sizeDelta.y));
        }

        public void updateAsync(GridViewCell cell, object value, IUIComponent component)
        {
            var text = component as Text;
            text.binder.updateField(data => data.text, value?.ToString() ?? "");
            text.binder.updateField(data => data.colorRole, cell.binder.data.showHighlight ? UISettings.ColorRole.OnPrimaryContainer : UISettings.ColorRole.OnSurface);
        }
    }

    public class DefaultGridViewCellContentRenderer : IGridViewCellRenderer
    {
        public async UniTask<IUIComponent> renderAsync(GridViewCell cell, object value)
        {
            return await Text.create(null, new TextData
            {
                text = value?.ToString() ?? "",
                opacity = 1.0f,
                textRole = UISettings.TextRole.LabelMedium,
                colorRole = cell.binder.data.showHighlight ? UISettings.ColorRole.OnPrimaryContainer : UISettings.ColorRole.OnSurfaceVariant,
                verticalAlignment = TMPro.VerticalAlignmentOptions.Geometry,
                wrapping = TMPro.TextWrappingModes.NoWrap,
                overflow = TMPro.TextOverflowModes.Ellipsis
            },
            async instance => instance.rectTransform.sizeDelta = new Vector2(cell.binder.data.width, instance.rectTransform.sizeDelta.y));
        }

        public void updateAsync(GridViewCell cell, object value, IUIComponent component)
        {
            var text = component as Text;
            text.binder.updateField(data => data.text, value?.ToString() ?? "");
            text.binder.updateField(data => data.colorRole, cell.binder.data.showHighlight ? UISettings.ColorRole.OnPrimaryContainer : UISettings.ColorRole.OnSurface);
        }
    }
}