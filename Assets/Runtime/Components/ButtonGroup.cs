using System;
using System.Collections.Generic;
using Cysharp.Threading.Tasks;



#if UNITY_EDITOR
using UnityEditor;
#endif
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;


namespace mdu.ui
{
    [Serializable]
    public struct ButtonGroupData
    {
        public ButtonGroup.Size size;
        public ButtonGroup.Type type;
        public ButtonGroup.SelectionMode selectionMode;

        public UnityEvent<int, Button, bool> onSelected;
    }

    [ExecuteInEditMode]
    [RequireComponent(typeof(HorizontalLayoutGroup))]
    public class ButtonGroup : UIComponent<ButtonGroup, ButtonGroupData>
    {
        public enum Size { XXS, XS, SM, MD, LG, XL }
        public enum Type { Standard, Connected }
        public enum SelectionMode { Single, Multi }

        [SerializeField] private HorizontalLayoutGroup _layout;

        private List<Button> _buttons;
        private Dictionary<Button, bool> _selectionState;

        public List<Button> buttons => _buttons;

        public override void setupUI(UISettings uISettings)
        {
            _layout = GetComponent<HorizontalLayoutGroup>();

            binder.bind(data => data.size, value =>
            {
                // dependency 
                var type = binder.data.type;
                switch (type)
                {
                    case Type.Standard:
                        _layout.spacing = value switch
                        {
                            Size.XS => 18,
                            Size.SM => 12,
                            Size.MD => 8,
                            Size.LG => 8,
                            Size.XL => 8,
                            _ => 18
                        };
                        break;
                    case Type.Connected:
                        _layout.spacing = 2; break;
                }

                refreshButtonGroup();

            }, dependsOn: data => data.type);

            binder.bind(data => data.type, value => refreshButtonGroup());
            binder.bind(data => data.selectionMode, value =>
            {
                // clear current seleciton
                _selectionState = new Dictionary<Button, bool>();

                refreshButtonGroup();
            });
        }

        private void refreshButtonGroup()
        {
            if (_buttons == null) { return; }

            for (var i = 0; i < _buttons.Count; ++i)
            {
                var button = _buttons[i];
                if (button == null) { continue; }
                if (button.rectTransform == null) { continue; }

                button.binder.updateField(data => data.size, binder.data.size switch
                {
                    Size.XXS => Button.Size.XXS,
                    Size.XS => Button.Size.XS,
                    Size.SM => Button.Size.SM,
                    Size.MD => Button.Size.MD,
                    Size.LG => Button.Size.LG,
                    Size.XL => Button.Size.XL,
                    _ => throw new NotImplementedException()
                });

                switch (binder.data.type)
                {
                    case Type.Standard:
                        if (_selectionState != null && _selectionState.GetValueOrDefault(button, false))
                        {
                            button.binder.updateField(data => data.shape, Button.Shape.Square);
                            button.binder.updateField(data => data.style, Button.Style.Tonal);
                        }
                        else
                        {
                            button.binder.updateField(data => data.shape, Button.Shape.Round);
                            button.binder.updateField(data => data.style, Button.Style.Filled);
                        }
                        break;
                    case Type.Connected:

                        if (_selectionState != null && _selectionState.GetValueOrDefault(button, false))
                        {
                            button.binder.updateField(data => data.shape, Button.Shape.Round);
                            button.binder.updateField(data => data.style, Button.Style.Filled);
                        }
                        else
                        {
                            var individualCornerSize = Vector4.one * binder.data.size switch
                            {
                                Size.XXS => 2,
                                Size.XS => 4,
                                Size.SM => 8,
                                Size.MD => 8,
                                Size.LG => 16,
                                Size.XL => 20,
                                _ => throw new NotImplementedException(),
                            };
                            if (i == 0) // first button
                            {
                                individualCornerSize.z = individualCornerSize.w = button.rectTransform.sizeDelta.y * 0.5f;
                            }
                            if (i == (_buttons.Count - 1)) // last button
                            {
                                individualCornerSize.x = individualCornerSize.y = button.rectTransform.sizeDelta.y * 0.5f;
                            }

                            button.binder.updateField(data => data.shape, Button.Shape.Individual);
                            button.binder.updateField(data => data.individualCornerSize, individualCornerSize);
                            button.binder.updateField(data => data.style, Button.Style.Tonal);
                        }
                        break;
                }
            }

            //LayoutRebuilder.ForceRebuildLayoutImmediate(rectTransform);
        }

        public override void Constructor()
        {
            base.Constructor();
            
            _buttons = new List<Button>();
            _selectionState = new Dictionary<Button, bool>();
            _layout = GetComponent<HorizontalLayoutGroup>();

            OnTransformChildrenChanged();
        }

        public UniTask<Button> addButton(ButtonData data, int insertAt = -1)
        {
            return Button.create(rectTransform, data).ContinueWith(button =>
            {
                if (insertAt >= 0)
                {
                    button.rectTransform.SetSiblingIndex(Mathf.Min(insertAt, rectTransform.childCount));
                }
                return button;
            });
        }

        public void removeButton(int index)
        {
            rectTransform.GetChild(index).GetComponent<Button>().Dispose();
        }
        
        protected void OnTransformChildrenChanged()
        {
            if (_buttons == null) { _buttons = new List<Button>(); }
            if (_selectionState == null) { _selectionState = new Dictionary<Button, bool>(); }

            _buttons.Clear();
            _selectionState.Clear();

            for (var i = 0; i < transform.childCount; ++i)
            {
                var child = transform.GetChild(i);
                if (child.TryGetComponent<Button>(out var button))
                {
                    var onClick = new UnityEvent();
                    var index = i;
                    onClick.AddListener(() =>
                    {
                        var currentState = _selectionState.GetValueOrDefault(button, false);
                        if (binder.data.selectionMode == SelectionMode.Single)
                        {
                            _selectionState.Clear();
                        }
                        
                        _selectionState[button] = !currentState;
                        binder.data.onSelected?.Invoke(index, button, _selectionState[button]);

                        refreshButtonGroup();
                    });
                    button.binder.updateField(data => data.onClick, onClick);
                    _buttons.Add(button);
                }
                else
                {
                    Debug.LogWarning($"{child} is not a ${typeof(Button)} and will be removed.");

                    if (Application.isPlaying)
                    {
                        UniTask.NextFrame().ContinueWith(() =>
                        {
                            if (child != null)
                            {
                                Destroy(child.gameObject);
                            }
                        });
                    }
                    else
                    {
#if UNITY_EDITOR
                        EditorApplication.delayCall += () =>
                        {
                            if (child != null)
                            {
                                DestroyImmediate(child.gameObject);
                            }
                        };
#endif
                    }
                }
            }

            refreshButtonGroup();
        }
    }
}