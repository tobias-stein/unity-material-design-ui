using System;
using System.Collections.Generic;
using System.Threading;
using com.convalise.UnityMaterialSymbols;
using Cysharp.Threading.Tasks;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;

namespace mdu.ui
{
    [Serializable]
    public struct SliderData
    {
        public Slider.Orientation orientation;
        public Slider.Size size;
        public Slider.Type type;
        public Slider.ValueIndicator valueIndicator;
        public bool showValueOpositeSide;
        public MaterialSymbolData icon0;
        public MaterialSymbolData icon1;

        public float minValue;
        public float maxValue;

        public float value0;
        public float value1;

        public bool discrete;
        [Min(2)] public int steps;
        public bool showOutterSteps;

        public UnityEvent<float, float> onValueChange;
    }

    public class Slider : UIComponent<Slider, SliderData>, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler, IPointerMoveHandler
    {
        public enum Size { XS, SM, MD, LG, XL }
        public enum Type { Standard, Range }
        public enum Orientation { Horizontal, Vertical }
        public enum ValueIndicator { DontShow, WhenPressed, Always }


        [SerializeField] private Icon _icon0;
        [SerializeField] private Icon _icon1;
        [SerializeField] private SDFQuad _backgroundTrack;
        [SerializeField] private SDFQuad _track;
        [SerializeField] private SliderHandle _handle0;
        [SerializeField] private SliderHandle _handle1;
        [SerializeField] private RectTransform _steps;

        private CancellationTokenSource _updateCTS;
        private List<Icon> _activeSteps;

        public override void setupUI(UISettings uISettings)
        {
            _handle0.color = uISettings.getColor(UISettings.ColorRole.Primary);
            _handle0.valueContainerColor = uISettings.getColor(UISettings.ColorRole.InverseSurface);
            _handle0.onMove = onMoveSliderHandle0;
            _handle1.color = uISettings.getColor(UISettings.ColorRole.Primary);
            _handle1.valueContainerColor = uISettings.getColor(UISettings.ColorRole.InverseSurface);
            _handle1.onMove = onMoveSliderHandle1;

            _track.fillColor = uISettings.getColor(UISettings.ColorRole.Primary);
            _backgroundTrack.fillColor = uISettings.getColor(UISettings.ColorRole.SecondaryContainer);

            binder.bind(data => data.size, value =>
            {
                // dependency 
                var orientation = binder.data.orientation;

                var length = Mathf.Max(Mathf.Max(rectTransform.rect.width, rectTransform.rect.height), 100.0f);
                var trackWidth = value switch
                {
                    Size.XS => 16.0f,
                    Size.SM => 24.0f,
                    Size.MD => 40.0f,
                    Size.LG => 56.0f,
                    Size.XL => 96.0f,
                    _ => 16.0f
                };
                var handleLength = value switch
                {
                    Size.XS => 44.0f,
                    Size.SM => 44.0f,
                    Size.MD => 52.0f,
                    Size.LG => 68.0f,
                    Size.XL => 108.0f,
                    _ => 44.0f
                };
                var iconSize = value switch
                {
                    Size.XS => Icon.Size.MD,
                    Size.SM => Icon.Size.MD,
                    Size.MD => Icon.Size.MD,
                    Size.LG => Icon.Size.MD,
                    Size.XL => Icon.Size.LG,
                    _ => Icon.Size.MD
                };
                var trackSize = orientation switch
                {
                    Orientation.Horizontal => new Vector2(length, trackWidth),
                    Orientation.Vertical => new Vector2(trackWidth, length),
                    _ => new Vector2(1.0f, 1.0f)
                };
                var handleSize = orientation switch
                {
                    Orientation.Horizontal => new Vector2(4.0f, handleLength),
                    Orientation.Vertical => new Vector2(handleLength, 4.0f),
                    _ => new Vector2(1.0f, 1.0f)
                };

                rectTransform.sizeDelta = trackSize;
                _handle0.size = _handle1.size = handleSize;

                // only show icon for slider bigger SM
                _icon0.binder.updateField(data => data.opacity, value > Size.SM ? 1.0f : 0.0f);
                _icon1.binder.updateField(data => data.opacity, value > Size.SM ? 1.0f : 0.0f);

            }, data => data.orientation);
            binder.bind(data => data.icon0, value => _icon0.binder.updateField(data => data.symbol, value));
            binder.bind(data => data.icon1, value => _icon1.binder.updateField(data => data.symbol, value));
            binder.bind(data => data.minValue, value =>
            {
                if (Mathf.Approximately(value, binder.data.maxValue)) { return; }

                if (value > binder.data.maxValue)
                {
                    binder.updateField(data => data.minValue, binder.data.maxValue);
                    return;
                }

                updateSlider();
            });
            binder.bind(data => data.maxValue, value =>
            {
                if (Mathf.Approximately(value, binder.data.minValue)) { return; }

                if (value < binder.data.minValue)
                {
                    binder.updateField(data => data.maxValue, binder.data.minValue);
                    return;
                }
                updateSlider();
            });
            binder.bind(data => data.value0, value =>
            {
                // dependency
                var minValue = binder.data.minValue;

                // value0 cannot exceed minValue
                if (value < minValue)
                {
                    binder.updateField(data => data.value0, minValue);
                    return;
                }

                updateSlider();
            }, data => data.minValue);
            binder.bind(data => data.value1, value =>
            {
                // dependency
                var maxValue = binder.data.maxValue;

                // value1 cannot not exceed maxValue
                if (value > maxValue)
                {
                    binder.updateField(data => data.value1, maxValue);
                    return;
                }

                updateSlider();
            }, data => data.maxValue);
            binder.bind(data => data.type, value =>
            {
                // dependency
                var size = binder.data.size;
                var orientation = binder.data.orientation;

                var cornerRadius = size switch
                {
                    Size.XS => 8.0f,
                    Size.SM => 8.0f,
                    Size.MD => 12.0f,
                    Size.LG => 16.0f,
                    Size.XL => 28.0f,
                    _ => 8.0f,
                };

                _backgroundTrack.radius = cornerRadius;

                switch (value)
                {
                    case Type.Standard:
                        _handle0.show = false;
                        _track.independent = true;
                        switch (orientation)
                        {
                            case Orientation.Horizontal:
                                _track.radiusX = 0.0f; // top-right
                                _track.radiusY = 0.0f; // bottom-right
                                _track.radiusZ = cornerRadius; // top-left
                                _track.radiusW = cornerRadius; // bottom-left
                                break;
                            case Orientation.Vertical:
                                _track.radiusX = 0.0f; // top-right
                                _track.radiusY = cornerRadius; // bottom-right
                                _track.radiusZ = 0.0f; // top-left
                                _track.radiusW = cornerRadius; // bottom-left
                                break;
                        }
                        break;
                    case Type.Range:
                        _handle0.show = true;
                        _track.independent = false;
                        _track.radius = 0.0f;
                        break;
                }

                updateSlider();
            }, data => data.size, data => data.orientation);
            binder.bind(data => data.orientation, value =>
            {
                var icon0RT = _icon0.GetComponent<RectTransform>();
                var icon1RT = _icon1.GetComponent<RectTransform>();
                switch (value)
                {
                    case Orientation.Horizontal:
                        _handle0.rectTransform.anchorMin = _handle1.rectTransform.anchorMin = _track.rectTransform.anchorMin = new Vector2(0, 0);
                        _handle0.rectTransform.anchorMax = _handle1.rectTransform.anchorMax = _track.rectTransform.anchorMax = new Vector2(0, 1);
                        _track.rectTransform.pivot = new Vector2(0.0f, 0.5f);

                        _handle0.rectTransform.sizeDelta = _handle1.rectTransform.sizeDelta = new Vector2(16.0f, 0.0f);

                        icon0RT.pivot = icon0RT.anchorMin = icon0RT.anchorMax = new Vector2(0.0f, 0.5f);
                        icon1RT.pivot = icon1RT.anchorMin = icon1RT.anchorMax = new Vector2(1.0f, 0.5f);
                        icon0RT.anchoredPosition = new Vector2(8.0f, 0.0f);
                        icon1RT.anchoredPosition = new Vector2(-8.0f, 0.0f);
                        break;
                    case Orientation.Vertical:
                        _handle0.rectTransform.anchorMin = _handle1.rectTransform.anchorMin = _track.rectTransform.anchorMin = new Vector2(0, 0);
                        _handle0.rectTransform.anchorMax = _handle1.rectTransform.anchorMax = _track.rectTransform.anchorMax = new Vector2(1, 0);
                        _track.rectTransform.pivot = new Vector2(0.5f, 1.0f);

                        _handle0.rectTransform.sizeDelta = _handle1.rectTransform.sizeDelta = new Vector2(0.0f, 16.0f);

                        icon0RT.pivot = icon0RT.anchorMin = icon0RT.anchorMax = new Vector2(0.5f, 1.0f);
                        icon1RT.pivot = icon1RT.anchorMin = icon1RT.anchorMax = new Vector2(0.5f, 0.0f);
                        icon0RT.anchoredPosition = new Vector2(0.0f, -8.0f);
                        icon1RT.anchoredPosition = new Vector2(0.0f, 8.0f);
                        break;
                }
            });
            binder.bind(data => data.discrete, value =>
            {
                _steps.gameObject.SetActive(value);
                updateSlider();
            });
            binder.bind(data => data.steps, async value =>
            {
                // dependencies
                var showOutterSteps = binder.data.showOutterSteps;

                if (Application.isPlaying && binder.data.discrete)
                {
                    var V = value - (showOutterSteps ? 0 : 2);
                    var C = _steps.childCount;

                    for (int i = 0; i < C; i++)
                    {
                        _steps.GetChild(i).GetComponent<IUI>().Dispose();
                    }

                    if (_activeSteps == null)
                    {
                        _activeSteps = new List<Icon>();
                    }
                    _activeSteps.Clear();

                    for (int i = 0; i < V; i++)
                    {
                        _activeSteps.Add(await Icon.create(_steps, new IconData
                        {
                            size = Icon.Size.XS,
                            colorRole = UISettings.ColorRole.InverseOnSurface,
                            opacity = 1.0f,
                            symbol = MaterialSymbolIcon.ICON_FIBER_MANUAL_RECORD_FILLED,
                        }));
                    }

                    updateSlider();
                }
            });
            binder.bind(data => data.showValueOpositeSide, value =>
            {
                // dependency
                var orientation = binder.data.orientation;

                switch (orientation)
                {
                    case Orientation.Horizontal:
                        if (value)
                        {
                            _handle0.valueContainer.anchorMin = _handle1.valueContainer.anchorMin = new Vector2(0.5f, 0.0f);
                            _handle0.valueContainer.anchorMax = _handle1.valueContainer.anchorMax = new Vector2(0.5f, 0.0f);
                            _handle0.valueContainer.pivot = _handle1.valueContainer.pivot = new Vector2(0.5f, 1.0f);
                            _handle0.valueContainer.anchoredPosition = _handle1.valueContainer.anchoredPosition = new Vector2(0.0f, -4.0f);
                        }
                        else
                        {
                            _handle0.valueContainer.anchorMin = _handle1.valueContainer.anchorMin = new Vector2(0.5f, 1.0f);
                            _handle0.valueContainer.anchorMax = _handle1.valueContainer.anchorMax = new Vector2(0.5f, 1.0f);
                            _handle0.valueContainer.pivot = _handle1.valueContainer.pivot = new Vector2(0.5f, 0.0f);
                            _handle0.valueContainer.anchoredPosition = _handle1.valueContainer.anchoredPosition = new Vector2(0.0f, 4.0f);
                        }
                        break;
                    case Orientation.Vertical:
                        if (value)
                        {
                            _handle0.valueContainer.anchorMin = _handle1.valueContainer.anchorMin = new Vector2(0.0f, 0.5f);
                            _handle0.valueContainer.anchorMax = _handle1.valueContainer.anchorMax = new Vector2(0.0f, 0.5f);
                            _handle0.valueContainer.pivot = _handle1.valueContainer.pivot = new Vector2(1.0f, 0.5f);
                            _handle0.valueContainer.anchoredPosition = _handle1.valueContainer.anchoredPosition = new Vector2(-4.0f, 0.0f);
                        }
                        else
                        {
                            _handle0.valueContainer.anchorMin = _handle1.valueContainer.anchorMin = new Vector2(1.0f, 0.5f);
                            _handle0.valueContainer.anchorMax = _handle1.valueContainer.anchorMax = new Vector2(1.0f, 0.5f);
                            _handle0.valueContainer.pivot = _handle1.valueContainer.pivot = new Vector2(0.0f, 0.5f);
                            _handle0.valueContainer.anchoredPosition = _handle1.valueContainer.anchoredPosition = new Vector2(4.0f, 0.0f);
                        }
                        break;
                }

            }, dependsOn: data => data.orientation);
            binder.bind(data => data.valueIndicator, value =>
            {
                switch (value)
                {
                    case ValueIndicator.DontShow:
                    case ValueIndicator.WhenPressed:
                        _handle0.valueContainer.gameObject.SetActive(false);
                        _handle1.valueContainer.gameObject.SetActive(false);
                        break;
                    case ValueIndicator.Always:
                        _handle0.valueContainer.gameObject.SetActive(true);
                        _handle1.valueContainer.gameObject.SetActive(true);
                        break;
                }
            });
        }

#if UNITY_EDITOR
        public new void OnValidate()
        {
            base.OnValidate();

            var value0 = binder.data.value0;
            var value1 = binder.data.value1;
            if (value0 > value1)
            {
                binder.updateField(data => data.value0, value1);
            }

            if (value1 < value0)
            {
                binder.updateField(data => data.value1, value0);
            }

            UnityEditor.EditorApplication.delayCall += () =>
            {
                if (this == null) { return; }
                updateSlider(true);
            };
        }
#endif

        private void onMoveSliderHandle0(PointerEventData eventData)
        {
            if (RectTransformUtility.ScreenPointToLocalPointInRectangle(rectTransform, eventData.position, eventData.pressEventCamera, out var localCursor))
            {
                (var length, var pos) = binder.data.orientation switch
                {
                    Orientation.Horizontal => (rectTransform.rect.width, localCursor.x),
                    Orientation.Vertical => (rectTransform.rect.height, localCursor.y),
                    _ => (1.0f, 0.0f)
                };

                var value0 = Mathf.Clamp(Mathf.Lerp(binder.data.minValue, binder.data.maxValue, pos / length), binder.data.minValue, binder.data.maxValue);
                var value1 = binder.data.value1;

                if (value0 <= value1)
                {
                    binder.updateField(data => data.value0, value0);
                }
            }
        }

        private void onMoveSliderHandle1(PointerEventData eventData)
        {
            if (RectTransformUtility.ScreenPointToLocalPointInRectangle(rectTransform, eventData.position, eventData.pressEventCamera, out var localCursor))
            {
                (var length, var pos) = binder.data.orientation switch
                {
                    Orientation.Horizontal => (rectTransform.rect.width, localCursor.x),
                    Orientation.Vertical => (rectTransform.rect.height, localCursor.y),
                    _ => (1.0f, 0.0f)
                };

                var value0 = binder.data.value0;
                var value1 = Mathf.Clamp(Mathf.Lerp(binder.data.minValue, binder.data.maxValue, pos / length), binder.data.minValue, binder.data.maxValue);

                if (value1 >= value0)
                {
                    binder.updateField(data => data.value1, value1);
                }
            }
        }

        public async void updateSlider(bool immediate = false)
        {
            // Cancel any previously scheduled update.
            if (_updateCTS != null && !_updateCTS.IsCancellationRequested)
            {
                _updateCTS.Cancel();
                _updateCTS.Dispose();
            }

            // If an immediate update is requested or debouncing is disabled, update now.
            if (immediate)
            {
                updateSliderInternal();
                return;
            }

            // Create a new CancellationTokenSource for this specific update request.
            _updateCTS = new CancellationTokenSource();

            try
            {
                // Wait for the specified delay. If cancelled, it will throw an exception.
                await UniTask.NextFrame(_updateCTS.Token);
                
                // If the delay completed without being cancelled, perform the update.
                updateSliderInternal();
            }
            catch (OperationCanceledException)
            {
                // This is expected if a new update is requested before the old one finishes.
                // We can safely ignore it.
            }
            finally
            {
                // Clean up the CancellationTokenSource
                if (_updateCTS != null)
                {
                    _updateCTS.Dispose();
                    _updateCTS = null;
                }
            }
        }
        
        private void updateSliderInternal()
        {
            var length = binder.data.orientation switch
            {
                Orientation.Horizontal => rectTransform?.rect.width ?? 1.0f,
                Orientation.Vertical => rectTransform?.rect.height ?? 1.0f,
                _ => 1.0f
            };
            var trackStart = 0.0f;
            var trackEnd = 0.0f;

            var minNormalized = binder.data.minValue - binder.data.minValue;
            var maxNormalized = binder.data.maxValue - binder.data.minValue;
            var N = maxNormalized - minNormalized;
            if (Mathf.Approximately(N, 0f))
            {
                N = 1.0f;
            }
            var value0Normalized = binder.data.value0 - binder.data.minValue;
            var value1Normalized = binder.data.value1 - binder.data.minValue;

            var stepSize = binder.data.steps > 1 ? N / (binder.data.steps - 1) : N;

            float snapValue(float value)
            {
                if (binder.data.steps <= 1)
                {
                    return binder.data.minValue;
                }

                // 2. Normalize the current value to a 0-1 scale.
                // This is the percentage of how far along the slider the handle is.
                float normalizedValue = value / N;

                // 3. Calculate the closest step index in the normalized 0-1 space.
                // We multiply by the number of "intervals" between steps, which is (numberOfSteps - 1).
                int stepIndex = Mathf.RoundToInt(normalizedValue * (binder.data.steps - 1));

                // 4. Calculate the snapped normalized value.
                // This is guaranteed to be a precise fraction, e.g., 0.0, 0.25, 0.5, 0.75, 1.0.
                float snappedNormalizedValue = (float)stepIndex / (binder.data.steps - 1);

                // 5. Denormalize the value back to the slider's original min/max range.
                float snappedValue = minNormalized + (snappedNormalizedValue * N);

                return snappedValue;
            }

            var _value0Vis = length * ((binder.data.discrete ? snapValue(value0Normalized) : value0Normalized) / N);
            var _value1Vis = length * ((binder.data.discrete ? snapValue(value1Normalized) : value1Normalized) / N);
            var _value0 = binder.data.discrete ? snapValue(value0Normalized) + binder.data.minValue : binder.data.value0;
            var _value1 = binder.data.discrete ? snapValue(value1Normalized) + binder.data.minValue : binder.data.value1;

            _handle0.valueText.binder.updateField(data => data.text, String.Format("{0:0.##}", _value0));
            _handle1.valueText.binder.updateField(data => data.text, String.Format("{0:0.##}", _value1));

            binder.data.onValueChange?.Invoke(binder.data.type == Type.Range ? _value0 : float.NaN, _value1);

            if (binder.data.discrete && _activeSteps != null)
            {
                var i = binder.data.showOutterSteps ? 0 : 1;
                var ssize = (binder.data.steps > 1 ? length / (binder.data.steps - 1) : length);
                foreach (var stepIcon in _activeSteps)
                {
                    var stepValue = ssize * i;

                    switch (binder.data.orientation)
                    {
                        case Orientation.Horizontal:
                            stepIcon.rectTransform.anchorMin = new Vector2(0, 0.5f);
                            stepIcon.rectTransform.anchorMax = new Vector2(0, 0.5f);
                            stepIcon.rectTransform.anchoredPosition = new Vector2(stepValue, 0.0f);
                            break;
                        case Orientation.Vertical:
                            stepIcon.rectTransform.anchorMin = new Vector2(0.5f, 0);
                            stepIcon.rectTransform.anchorMax = new Vector2(0.5f, 0);
                            stepIcon.rectTransform.anchoredPosition = new Vector2(0.0f, stepValue);
                            break;
                    }

                    stepIcon.binder.updateField(data => data.opacity, (Mathf.Approximately(_value1Vis, stepValue) || (binder.data.type == Type.Range && Mathf.Approximately(_value0Vis, stepValue))) ? 0f : 1.0f);

                    switch (binder.data.type)
                    {
                        case Type.Standard:
                            stepIcon.binder.updateField(data => data.colorRole, stepValue < _value1Vis
                                ? UISettings.ColorRole.PrimaryContainer
                                : UISettings.ColorRole.OnSecondaryContainer
                            );
                            break;
                        case Type.Range:
                            stepIcon.binder.updateField(data => data.colorRole, stepValue > _value0Vis && stepValue < _value1Vis
                                    ? UISettings.ColorRole.PrimaryContainer
                                    : UISettings.ColorRole.OnSecondaryContainer
                                );
                            break;
                    }

                    i++;
                }
            }

            // set sliders and track
            switch (binder.data.type)
                {
                    case Type.Standard:
                        trackStart = 0.0f;
                        trackEnd = _value1Vis;
                        break;
                    case Type.Range:
                        trackStart = _value0Vis;
                        trackEnd = _value1Vis;
                        break;
                }
            switch (binder.data.orientation)
            {
                case Orientation.Horizontal:
                    _handle0.rectTransform.anchoredPosition = _track.rectTransform.anchoredPosition = new Vector2(trackStart, 0.0f);
                    _handle1.rectTransform.anchoredPosition = new Vector2(trackEnd, 0.0f);
                    _track.rectTransform.sizeDelta = new Vector2(trackEnd - trackStart, 0.0f);
                    break;
                case Orientation.Vertical:
                    _handle0.rectTransform.anchoredPosition = new Vector2(0.0f, trackStart);
                    _handle1.rectTransform.anchoredPosition = new Vector2(0.0f, trackEnd);
                    _track.rectTransform.anchoredPosition = new Vector2(0.0f, trackStart + (trackEnd - trackStart));
                    _track.rectTransform.sizeDelta = new Vector2(0.0f, trackEnd - trackStart);
                    break;
            }
        }

        #region IPOINTER & IDRAG

        public void OnPointerMove(PointerEventData eventData)
        {
            if (_handle0.show)
            {
                ExecuteEvents.Execute(_handle0.gameObject, eventData, ExecuteEvents.pointerMoveHandler);
            }
            ExecuteEvents.Execute(_handle1.gameObject, eventData, ExecuteEvents.pointerMoveHandler);
        }

        public void OnPointerExit(PointerEventData eventData)
        {
            if (_handle0.show)
            {
                ExecuteEvents.Execute(_handle0.gameObject, eventData, ExecuteEvents.pointerExitHandler);
            }
            ExecuteEvents.Execute(_handle1.gameObject, eventData, ExecuteEvents.pointerExitHandler);

            if (binder.data.valueIndicator == ValueIndicator.WhenPressed)
            {
                _handle0.valueContainer.gameObject.SetActive(false);
                _handle1.valueContainer.gameObject.SetActive(false);
            }
        }

        public void OnPointerDown(PointerEventData eventData)
        {
            if (_handle0.show && RectTransformUtility.RectangleContainsScreenPoint(_handle0.rectTransform, eventData.position, eventData.pressEventCamera))
            {
                ExecuteEvents.Execute(_handle0.gameObject, eventData, ExecuteEvents.pointerDownHandler);
                if (binder.data.valueIndicator == ValueIndicator.WhenPressed)
                {
                    _handle0.valueContainer.gameObject.SetActive(true);
                }
            }
            else if (RectTransformUtility.RectangleContainsScreenPoint(_handle1.rectTransform, eventData.position, eventData.pressEventCamera))
            {
                ExecuteEvents.Execute(_handle1.gameObject, eventData, ExecuteEvents.pointerDownHandler);
                if (binder.data.valueIndicator == ValueIndicator.WhenPressed)
                {
                    _handle1.valueContainer.gameObject.SetActive(true);
                }
            }
            else // track
            {
                if (RectTransformUtility.ScreenPointToLocalPointInRectangle(rectTransform, eventData.position, eventData.pressEventCamera, out var localCursor))
                {
                    (var length, var pos) = binder.data.orientation switch
                    {
                        Orientation.Horizontal => (rectTransform.rect.width, localCursor.x),
                        Orientation.Vertical => (rectTransform.rect.height, localCursor.y),
                        _ => (1.0f, 0.0f)
                    };

                    var centerPoint = binder.data.type switch
                    {
                        Type.Standard => binder.data.orientation switch
                        {
                            Orientation.Horizontal => _handle1.rectTransform.anchoredPosition.x,
                            Orientation.Vertical => _handle1.rectTransform.anchoredPosition.y,
                            _ => 0.0f
                        },
                        Type.Range => binder.data.orientation switch
                        {
                            Orientation.Horizontal => Mathf.Lerp(_handle0.rectTransform.anchoredPosition.x, _handle1.rectTransform.anchoredPosition.x, 0.5f),
                            Orientation.Vertical => Mathf.Lerp(_handle0.rectTransform.anchoredPosition.y, _handle1.rectTransform.anchoredPosition.y, 0.5f),
                            _ => 0.0f
                        },
                        _ => 0.0f
                    };

                    var pickSlider1 = binder.data.type switch
                    {
                        Type.Standard => true,
                        Type.Range => pos > centerPoint,
                        _ => false
                    };

                    if (pickSlider1)
                    {
                        ExecuteEvents.Execute(_handle1.gameObject, eventData, ExecuteEvents.pointerDownHandler);
                        if (binder.data.valueIndicator == ValueIndicator.WhenPressed)
                        {
                            _handle1.valueContainer.gameObject.SetActive(true);
                        }
                    }
                    else
                    {
                        ExecuteEvents.Execute(_handle0.gameObject, eventData, ExecuteEvents.pointerDownHandler);
                        if (binder.data.valueIndicator == ValueIndicator.WhenPressed)
                        {
                            _handle0.valueContainer.gameObject.SetActive(true);
                        }
                    }
                }
            }
        }

        public void OnPointerUp(PointerEventData eventData)
        {
            if (_handle0.show)
            {
                ExecuteEvents.Execute(_handle0.gameObject, eventData, ExecuteEvents.pointerUpHandler);
            }
            ExecuteEvents.Execute(_handle1.gameObject, eventData, ExecuteEvents.pointerUpHandler);

            if (binder.data.valueIndicator == ValueIndicator.WhenPressed)
            {
                _handle0.valueContainer.gameObject.SetActive(false);
                _handle1.valueContainer.gameObject.SetActive(false);
            }
        }

        #endregion
    }
}