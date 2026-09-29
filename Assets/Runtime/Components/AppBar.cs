using System;
using TMPro;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct AppBarData
    {
        public string title;
        public string subtitle;
        public UnityEvent onBack;
        public AppBar.TitleAlignment titleAlignment;
        public AppBar.Size size;
    }

    public class AppBar : UIComponent<AppBar, AppBarData>
    {
        public enum Size { SM, MD, LG }
        public enum TitleAlignment { left, center }

        [SerializeField] private GameObject _titleAndSubtitle;
        [SerializeField] private Button _button;
        [SerializeField] private Text _title;
        [SerializeField] private Text _subtitle;
        [SerializeField] private Button _prefixButton;

        public string title
        {
            set
            {
                _title.binder.updateField(data => data.text, value);
            }
        }

        public string subtitle
        {
            set
            {
                if (string.IsNullOrEmpty(value))
                {
                    _subtitle.gameObject.SetActive(false);
                }
                else
                {
                    _subtitle.gameObject.SetActive(true);
                    _subtitle.binder.updateField(data => data.text, value);
                }

                LayoutRebuilder.MarkLayoutForRebuild(GetComponent<RectTransform>());
            }
        }
        
        public UISettings.TextRole titleRole
        {
            set
            {
                _title.binder.updateField(data => data.textRole, value);
            }
        }

        public UISettings.TextRole subtitleRole
        {
            set
            {
                _subtitle.binder.updateField(data => data.textRole, value);
            }
        }

        public HorizontalAlignmentOptions titleAlignment
        {
            set
            {
                _title.binder.updateField(data => data.horizontalAlignment, value);
            }
        }

        public HorizontalAlignmentOptions subtitleAlignment
        {
            set
            {
                _subtitle.binder.updateField(data => data.horizontalAlignment, value);
            }
        }

        public override void setupUI(UISettings uiSettings)
        {
            binder.bind(data => data.size, value =>
            {
                switch (value)
                {
                    case Size.SM:
                        titleRole = UISettings.TextRole.TitleLarge;
                        subtitleRole = UISettings.TextRole.BodySmall;
                        _button.binder.updateField(data => data.size, Button.Size.SM);
                        break;
                    case Size.MD:
                        titleRole = UISettings.TextRole.HeadlineMedium;
                        subtitleRole = UISettings.TextRole.BodyMedium;
                        _button.binder.updateField(data => data.size, Button.Size.MD);
                        break;
                    case Size.LG:
                        titleRole = UISettings.TextRole.DisplaySmall;
                        subtitleRole = UISettings.TextRole.BodyLarge;
                        _button.binder.updateField(data => data.size, Button.Size.LG);
                        break;
                }
            });

            binder.bind(data => data.titleAlignment, value =>
            {
                switch (value)
                {
                    case TitleAlignment.left:
                        titleAlignment = TMPro.HorizontalAlignmentOptions.Left;
                        subtitleAlignment = TMPro.HorizontalAlignmentOptions.Left;
                        break;
                    case TitleAlignment.center:
                        titleAlignment = TMPro.HorizontalAlignmentOptions.Center;
                        subtitleAlignment = TMPro.HorizontalAlignmentOptions.Center;
                        break;
                }
            });

            binder.bind(data => data.title, value => title = value);
            binder.bind(data => data.subtitle, value => subtitle = value);
            binder.bind(data => data.onBack, value => _prefixButton.binder.updateField(data => data.onClick, value));
        }
    }
}