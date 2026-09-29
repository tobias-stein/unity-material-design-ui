using System;
using com.convalise.UnityMaterialSymbols;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct GridViewCellData
    {
        [Serializable]
        public struct Border
        {
            public Vector4 width; // top, right, bottom, left
            public Color color;

            public Border(float width, Color color)
            {
                this.width = new Vector4(width, width, width, width);
                this.color = color;
            }

            public Border(Vector4 width, Color color)
            {
                this.width = width;
                this.color = color;
            }

            public static Border none => new Border(0, Color.clear);
        }
        
        public string columnKey;
        public GridViewColumn.Alignment alignment;
        public float width;
        public float height;
        public int padding;
        public MaterialSymbolData prefixIcon;
        public Color prefixIconColor;

        public bool showHighlight;
        public UISettings.ColorRole backgroundColor;

        public Border border;
    }
    
    public class GridViewCell : UIComponent<GridViewCell, GridViewCellData>, IPointerClickHandler
    {
        [SerializeField] private HorizontalLayoutGroup _layout;
        [SerializeField] private GridViewCellImage _image;
        [SerializeField] private Icon _prefixIcon;
        [SerializeField] private RectTransform _contentContainer;

        private IUIComponent _content;

        public event Action onCellClicked;

        public new void Dispose()
        {
            onCellClicked = null;
            _content?.Dispose();
            base.Dispose();
        }

        public void OnPointerClick(PointerEventData eventData) => onCellClicked?.Invoke();

        public void setContent(IUIComponent content)
        {
            _content = content;
            content.rectTransform.SetParent(_contentContainer, false);
        }

        public IUIComponent getContent() => _content;

        public override void setupUI(UISettings uiSettings)
        {
            binder.bind(data => data.backgroundColor, value =>
            {
                // dependency
                var showHighlight = binder.data.showHighlight;

                _image.color = showHighlight
                    ? uiSettings.getColor(UISettings.ColorRole.PrimaryContainer)
                    : uiSettings.getColor(value);

            }, dependsOn: data => data.showHighlight);

            binder.bind(data => data.alignment, value =>
            {
                _layout.childAlignment = value switch
                {
                    GridViewColumn.Alignment.Left => TextAnchor.MiddleLeft,
                    GridViewColumn.Alignment.Center => TextAnchor.MiddleCenter,
                    GridViewColumn.Alignment.Right => TextAnchor.MiddleRight,
                    _ => TextAnchor.MiddleCenter
                };
            });

            binder.bind(data => data.width, value =>
            {
                rectTransform.sizeDelta = new Vector2(value, rectTransform.sizeDelta.y);
            });

            binder.bind(data => data.height, value =>
            {
                rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, value);
            });

            binder.bind(data => data.prefixIcon, value =>
            {
                if (value.code == '\0')
                {
                    _prefixIcon.gameObject.SetActive(false);
                }
                else
                {
                    if (_prefixIcon.gameObject.activeSelf == false)
                    {
                        _prefixIcon.gameObject.SetActive(true);
                    }
                    
                    _prefixIcon.binder.updateField(data => data.symbol, value);        
                }
            });
            binder.bind(data => data.prefixIconColor, value => _prefixIcon.binder.updateField(data => data.customColor, value));

            binder.bind(data => data.padding, value =>
            {
                _layout.padding = new RectOffset(value, value, value, value);
                _layout.spacing = value;
            });

            binder.bind(data => data.border, value => _image.SetBorders(value));
        }
    }
}