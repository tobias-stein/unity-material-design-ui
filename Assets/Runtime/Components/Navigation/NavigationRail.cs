using System;
using System.Collections.Generic;
using System.Linq;
using Cysharp.Threading.Tasks;
using DG.Tweening;
using UnityEngine;
using UnityEngine.Events;

namespace mdu.ui
{
    [Serializable]
    public struct NavigagtionRailData
    {
        public UnityEvent<bool> onMenuStateChanged;
        public ButtonData primaryButton;
        public bool open;
        public bool showMenu;
        public bool showPrimary;
    }

    public class NavigationRail : UIComponent<NavigationRail, NavigagtionRailData>
    {
        const int CLOSED_WIDTH = 96;
        const int OPENED_WIDTH = 320;

        [SerializeField] private Button _menuButton;
        [SerializeField] private Button _primaryButton;
        [SerializeField] private RectTransform _menuItemsRoot;


        private UnityEvent<bool> _onMenuStateChanged;
        private Sequence _menuAnimation;

        private List<IUI> _menuItems = new List<IUI>();

        public UniTask<ListItem> addMenuItem(ListItemData data)
        {
            return ListItem.create(_menuItemsRoot, data).ContinueWith(instance =>
            {
                _menuItems.Add(instance);
                return instance;
            });
        }

        public UniTask addSeperator()
        {
            return Seperator.create(_menuItemsRoot).ContinueWith(instance => _menuItems.Add(instance));   
        }

        public UniTask<Text> addSectionHeader(string text)
        {
            return Text.create(_menuItemsRoot, new TextData
            {
                text = text,
                textRole = UISettings.TextRole.TitleMedium,
                colorRole = UISettings.ColorRole.OnSurfaceVariant,
                opacity = 1f,
                wrapping = TMPro.TextWrappingModes.NoWrap,
                overflow = TMPro.TextOverflowModes.Ellipsis
            }).ContinueWith(instance =>
            {
                _menuItems.Add(instance);
                return instance;
            });
        }

        public void clearMenuItems()
        {
            _menuItems.ForEach(i => i.Dispose());
            _menuItems.Clear();
        }

        public override void setupUI(UISettings uISettings)
        {
            _menuAnimation?.Kill();

            #region DATA BINDING

            var onClick = new UnityEvent();
            onClick.AddListener(toggleMenu);
            _menuButton.binder.updateField(data => data.onClick, onClick);

            binder.bind(data => data.onMenuStateChanged, value => _onMenuStateChanged = value);
            binder.bind(data => data.showMenu, value => _menuButton.transform.parent.gameObject.SetActive(value));
            binder.bind(data => data.showPrimary, value => _primaryButton.transform.parent.gameObject.SetActive(value));
            binder.bind(data => data.primaryButton, value => _primaryButton.binder.data = value);
            binder.bind(data => data.open, value =>
            {
                if (Application.isPlaying)
                {
                    animateMenu(value);
                }
                else
                {
                    resetMenu(value);
                }
            });

            #endregion
        }

        public void toggleMenu() => binder.updateField(data => data.open, !binder.data.open);

        private void resetMenu(bool isOpen)
        {
            _menuButton.binder.updateField(data => data.icon, isOpen ? MaterialSymbolIcon.ICON_MENU_OPEN : MaterialSymbolIcon.ICON_MENU);

            rectTransform.sizeDelta = new Vector2(isOpen ? OPENED_WIDTH : CLOSED_WIDTH, rectTransform.sizeDelta.y);

            foreach (var item in _menuItems)
            {
                if (item is Text sh)
                {
                    sh.binder.updateField(data => data.opacity, isOpen ? 1f : 0f);
                }
                else if (item is ListItem li)
                {
                    li._layout.padding.left = li._layout.padding.right = isOpen ? 16 : 0;
                    li.binder.updateField(data => data.alignment, isOpen ? ListItem.Alignment.Horizontal : ListItem.Alignment.Vertical);
                    li.binder.updateField(data => data.showSubtitle, isOpen);
                    li.binder.updateField(data => data.showPostfix, isOpen);
                }
            }
        }

        #region ANIMATION

        private void animateMenu(bool isOpen)
        {
            _menuAnimation?.Kill();
            _menuAnimation = DOTween.Sequence().Join(rectTransform.DOSizeDelta(new Vector2(isOpen ? OPENED_WIDTH : CLOSED_WIDTH, rectTransform.sizeDelta.y), 0.2f));
            _menuAnimation
                .OnStart(() => resetMenu(isOpen))
                .OnComplete(() =>
                {
                    _menuButton.binder.updateField(data => data.icon, isOpen ? MaterialSymbolIcon.ICON_MENU_OPEN : MaterialSymbolIcon.ICON_MENU);
                    _onMenuStateChanged?.Invoke(isOpen);
                })
                .SetEase(Ease.OutQuad);
        }


        #endregion

        new void OnDestroy()
        {
            base.OnDestroy();
            _menuAnimation?.Kill();
        }
    }
}