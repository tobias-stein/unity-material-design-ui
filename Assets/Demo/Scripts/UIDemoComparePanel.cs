using System;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;
using Random = UnityEngine.Random;

namespace mdu.ui
{
    [Serializable]
    public struct UIDemoComparePanelData
    {
        public string title;
        public bool closable;
        public bool comparable;
        public UnityEvent onCompare;
    }

    [RequireComponent(typeof(LayoutElement))]
    public class UIDemoComparePanel : UIComponent<UIDemoComparePanel, UIDemoComparePanelData>, IStackPanel
    {
        [SerializeField] private Text _title;
        [SerializeField] private Button _close;
        [SerializeField] private Button _compare;
        [SerializeField] private RectTransform _content;

        public Action<IStackPanel> onOpening { get; set; }
        public Action<IStackPanel> onOpened { get; set; }
        public Action<IStackPanel> onClosing { get; set; }
        public Action<IStackPanel> onClosed { get; set; }
        public Action<IStackPanel> onResize { get; set; }

        public LayoutElement layoutElement => _layoutElement;

        private LayoutElement _layoutElement;
        private float parentWidth => transform.parent.GetComponentInParent<RectTransform>().rect.width;
        private float parentHeight => transform.parent.GetComponentInParent<RectTransform>().rect.height;

        private StackPanelOrentation orientation = StackPanelOrentation.Horizontal;

        private IUI _spawnedUIComponent;

        public void setOrientation(StackPanelOrentation newOrientation) => orientation = newOrientation;

        public new void Awake()
        {
            base.Awake();
            _layoutElement = GetComponent<LayoutElement>();
            _spawnedUIComponent = null;
        }

        public override void setupUI(UISettings uISettings)
        {
            _layoutElement = GetComponent<LayoutElement>();

            binder.bind(data => data.title, value => _title.binder.updateField(data => data.text, value));
            binder.bind(data => data.closable, value => _close.gameObject.SetActive(value));
            binder.bind(data => data.comparable, value => _compare.gameObject.SetActive(value));
            binder.bind(data => data.onCompare, value => _compare.binder.updateField(data => data.onClick, value));

            var onClick = new UnityEvent();
            onClick.AddListener(close);
            _close.binder.updateField(data => data.onClick, onClick);
        }

        private async Task spawnRandomUIComponents()
        {
            var randomComponent = Random.Range(0, 6);
            switch (randomComponent)
            {
                case 0:
                    _spawnedUIComponent = await Button.create(_content, new ButtonData
                    {
                        style = (Button.Style)Random.Range(0, 5),
                        shape = (Button.Shape)Random.Range(0, 3),
                        size = Button.Size.MD,
                        text = GetRandomLabel(),
                        icon = GetRandomIcon(),
                        showLabel = Random.value > 0.5f,
                        showIcon = Random.value > 0.5f,
                        iconRight = Random.value > 0.5f,
                        enabled = true,
                        //preferredWidth = Random.Range(80, 300)
                    });
                    break;
                case 1:
                    _spawnedUIComponent = await Slider.create(_content, new SliderData
                    {
                        orientation = (Slider.Orientation)Random.Range(0, 2),
                        size = Slider.Size.MD,
                        type = (Slider.Type)Random.Range(0, 2),
                        valueIndicator = (Slider.ValueIndicator)Random.Range(0, 3),
                        showValueOpositeSide = Random.value > 0.5f,
                        icon0 = GetRandomIcon(),
                        icon1 = GetRandomIcon(),
                        minValue = Random.Range(0f, 50f),
                        maxValue = Random.Range(51f, 100f),
                        value0 = Random.Range(0f, 50f),
                        value1 = Random.Range(51f, 100f),
                        discrete = Random.value > 0.5f,
                        steps = Random.Range(2, 11),
                        showOutterSteps = Random.value > 0.5f
                    });
                    break;
                case 2:
                    _spawnedUIComponent = await Chip.create(_content, new ChipData
                    {
                        style = Chip.Style.Filled,
                        icon = GetRandomIcon(),
                        label = GetRandomLabel(),
                        colorRole = UISettings.ColorRole.PrimaryContainer,
                        showIcon = Random.value > 0.5f,
                        closable = Random.value > 0.5f,
                        enabled = true
                    });
                    break;
                case 3:
                    _spawnedUIComponent = await Icon.create(_content, new IconData
                    {
                        symbol = GetRandomIcon(),
                        colorRole = (UISettings.ColorRole)Random.Range(0, 32),
                        opacity = 1.0f,
                        size = Icon.Size.XXL
                    });
                    break;
                case 4:
                    _spawnedUIComponent = await LoadingIndicator.create(_content, new LoadingIndicatorData
                    {
                        progress = Random.value,
                        shape = (LoadingIndicator.Shape)Random.Range(0, 2),
                        size = LoadingIndicator.Size.LG,
                        intermediate = true,
                        flatten = Random.value > 0.5f,
                        gap = Random.Range(1f, 10f)
                    });
                    break;
                case 5:
                    _spawnedUIComponent = await Switch.create(_content, new SwitchData
                    {
                        enabled = true,
                        isOn = Random.value > 0.5f,
                        showOnIcon = Random.value > 0.5f,
                        showOffIcon = Random.value > 0.5f,
                        onIcon = GetRandomIcon(),
                        offIcon = GetRandomIcon()
                    });
                    break;
            }
        }

        private static string GetRandomLabel()
        {
            string[] labels = { "Hello", "World", "Click", "Submit", "Cancel", "Delete", "Add", "Remove", "Settings", "Search" };
            return labels[Random.Range(0, labels.Length)];
        }

        private static com.convalise.UnityMaterialSymbols.MaterialSymbolData GetRandomIcon()
        {
            return new com.convalise.UnityMaterialSymbols.MaterialSymbolData((char)Random.Range(0xe000, 0xf8ff), Random.value > 0.5f);
        }

        public void close() => onClosing?.Invoke(this);

         #region ANIMATION

        private float easeInOutQuart(float x) => x < 0.5 ? 8 * x * x * x * x : 1 - Mathf.Pow(-2 * x + 2, 4) / 2;

        public async UniTask animateOpen(float duration, bool scaleRelative = true)
        {
            onOpening?.Invoke(this);

            await spawnRandomUIComponents();

            float initialSize = 0f;
            float targetSize = (orientation == StackPanelOrentation.Horizontal)
                ? scaleRelative
                    ? 1f 
                    : parentWidth
                : scaleRelative
                    ? 1f 
                    : parentHeight;

            float elapsedTime = 0f;

            var cancellationToken = this.GetCancellationTokenOnDestroy();

            while (elapsedTime < duration)
            {
                elapsedTime += Time.deltaTime;
                float t = Mathf.Clamp01(elapsedTime / duration);
                float newSize = Mathf.Lerp(initialSize, targetSize, easeInOutQuart(t));

                if (orientation == StackPanelOrentation.Horizontal)
                {
                    if (scaleRelative)
                    {
                        layoutElement.preferredWidth = 0f;
                        layoutElement.flexibleWidth = newSize;
                    }
                    else
                    {
                        layoutElement.flexibleWidth = 0f;
                        layoutElement.preferredWidth = newSize;
                    }
                }
                else
                { 
                    if (scaleRelative)
                    {
                        layoutElement.preferredHeight = 0f;
                        layoutElement.flexibleHeight = newSize;
                    }
                    else
                    {
                        layoutElement.flexibleHeight = 0f;
                        layoutElement.preferredHeight = newSize;
                    }
                }

                onResize?.Invoke(this);

                await UniTask.Yield(PlayerLoopTiming.Update, cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;
            }

            if (orientation == StackPanelOrentation.Horizontal)
            {
                layoutElement.preferredWidth = 0f;
                layoutElement.flexibleWidth = 1f;
            }
            else
            { 
                layoutElement.preferredHeight = 0f;
                layoutElement.flexibleHeight = 1f;
            }

            onResize?.Invoke(this);
            onOpened?.Invoke(this);
        }

        public async UniTask animateClose(float duration, bool scaleRelative = true)
        {
            float targetSize = 0f;
            float initialSize = (orientation == StackPanelOrentation.Horizontal)
                ? scaleRelative
                    ? 1f 
                    : parentWidth
                : scaleRelative
                    ? 1f 
                    : parentHeight;

            float elapsedTime = 0f;

            var cancellationToken = this.GetCancellationTokenOnDestroy();

            while (elapsedTime < duration)
            {
                elapsedTime += Time.deltaTime;
                float t = Mathf.Clamp01(elapsedTime / duration);
                float newSize = Mathf.Lerp(initialSize, targetSize, easeInOutQuart(t));

                if (orientation == StackPanelOrentation.Horizontal)
                {
                    if (scaleRelative)
                    {
                        layoutElement.preferredWidth = 0f;
                        layoutElement.flexibleWidth = newSize;
                    }
                    else
                    {
                        layoutElement.flexibleWidth = 0f;
                        layoutElement.preferredWidth = newSize;
                    }
                }
                else
                { 
                    if (scaleRelative)
                    {
                        layoutElement.preferredHeight = 0f;
                        layoutElement.flexibleHeight = newSize;
                    }
                    else
                    {
                        layoutElement.flexibleHeight = 0f;
                        layoutElement.preferredHeight = newSize;
                    }
                }

                onResize?.Invoke(this);

                await UniTask.Yield(PlayerLoopTiming.Update, cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;
            }

            if (orientation == StackPanelOrentation.Horizontal)
            {
                layoutElement.preferredWidth = 0f;
                layoutElement.flexibleWidth = 0f;
            }
            else
            { 
                layoutElement.preferredHeight = 0f;
                layoutElement.flexibleHeight = 0f;
            }

            onResize?.Invoke(this);
            onClosed?.Invoke(this);
        }

        #endregion
    }
}