using System;
using DG.Tweening;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct LoadingIndicatorData
    {
        [Range(0.0f, 1.0f)]
        public float progress;
        public LoadingIndicator.Shape shape;
        public LoadingIndicator.Size size;
        public bool intermediate;
        public bool flatten;
        public float gap;
    }

    public class LoadingIndicator : UIComponent<LoadingIndicator, LoadingIndicatorData>
    {
        public enum Size { SM, MD, LG, XL }
        public enum Shape { linear, circular }

        [SerializeField] private SDFQuad _linearTrack, _linearIndicator;
        [SerializeField] private SDFArc _circularTrack, _circularIndicator;
        [SerializeField] private RectTransform _linearTrackRT;
        [SerializeField] private RectTransform _linearIndicatorRT;

        private float _gap;
        private float _trackSize;

        private float _trackStart, _trackEnd;
        private float _indicatorStart, _indicatorEnd;

        private Tweener _determinedTweener, _intermediateTweener;

        
        public new void OnDisable()
        {
            base.OnDisable();

            _intermediateTweener?.Kill();
            _determinedTweener?.Kill();
        }

        public new void OnDestroy()
        {
            base.OnDestroy();

            _intermediateTweener?.Kill();
            _determinedTweener?.Kill();
        }

        public override void setupUI(UISettings uISettings)
        {
            binder.bind(data => data.progress, value =>
            {
                if (Application.isPlaying)
                {
                    _intermediateTweener?.Kill();
                    _determinedTweener?.Kill();

                    _determinedTweener = DOTween.To(() => 0f, x => setProgress(x), value, 0.2f)
                                .SetEase(Ease.Linear)
                                .OnKill(() => setProgress(value));
                }
                else
                {
                    setProgress(value);
                }
            });
            binder.bind(data => data.intermediate, value =>
            {
                //dependency
                var progress = binder.data.progress;

                if (Application.isPlaying)
                {
                    _intermediateTweener?.Kill();
                    _determinedTweener?.Kill();

                    if (value)
                    {
                        _intermediateTweener = DOTween.To(() => 0f, x => setProgress(x), 1f, 1.0f)
                                .SetEase(Ease.Linear)
                                .SetLoops(-1, LoopType.Restart);
                    }
                    else
                    {
                        _determinedTweener = DOTween.To(() => 0f, x => setProgress(x), progress, 0.2f)
                                .SetEase(Ease.Linear);
                    }
                }
                else
                {
                    if (!value)
                    {
                        setProgress(progress);
                    }
                }
            }, dependsOn: data => data.progress);
            binder.bind(data => data.gap, value =>
            {
                // dependency
                var shape = binder.data.shape;

                switch (shape)
                {
                    case Shape.linear:
                        _gap = UISettings.DpToUnityUnits(value) * 0.5f;
                        break;
                    case Shape.circular:
                        _gap = UISettings.DpToUnityUnits(value + _trackSize) * 0.5f;
                        break;
                }
            }, data => data.shape, data => data.size);
            binder.bind(data => data.size, value =>
            { 
                _trackSize = value switch
                {
                    Size.SM => UISettings.DpToUnityUnits(4.0f),
                    Size.MD => UISettings.DpToUnityUnits(8.0f),
                    Size.LG => UISettings.DpToUnityUnits(10.0f),
                    Size.XL => UISettings.DpToUnityUnits(14.0f),
                    _ => UISettings.DpToUnityUnits(4.0f)
                };
            });
            binder.bind(data => data.shape, value =>
            {
                // dependency
                var flatten = binder.data.flatten;
                var size = binder.data.size;

                switch (value)
                {
                    case Shape.linear:
                        _linearTrack.gameObject.SetActive(true);
                        _linearIndicator.gameObject.SetActive(true);
                        _circularTrack.gameObject.SetActive(false);
                        _circularIndicator.gameObject.SetActive(false);
                        _linearTrack.fillColor = uISettings.getColor(UISettings.ColorRole.SecondaryContainer);
                        _linearIndicator.fillColor = uISettings.getColor(UISettings.ColorRole.Primary);

                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, _trackSize);

                        _linearTrack.radius = flatten ? 0f : _trackSize;
                        _linearIndicator.radius = flatten ? 0f : _trackSize;
                        break;
                    case Shape.circular:
                        _linearTrack.gameObject.SetActive(false);
                        _linearIndicator.gameObject.SetActive(false);
                        _circularTrack.gameObject.SetActive(true);
                        _circularIndicator.gameObject.SetActive(true);
                        _circularTrack.fillColor = uISettings.getColor(UISettings.ColorRole.SecondaryContainer);
                        _circularIndicator.fillColor = uISettings.getColor(UISettings.ColorRole.Primary);

                        // Set anchors to the center of the parent
                        rectTransform.anchorMin = new Vector2(0.5f, 0.5f);
                        rectTransform.anchorMax = new Vector2(0.5f, 0.5f);
                        // Set the pivot to the center of the element
                        rectTransform.pivot = new Vector2(0.5f, 0.5f);
                        // Set the position to the center (0,0) relative to the anchors
                        rectTransform.anchoredPosition = Vector2.zero;
                        float circleSize = size switch
                        {
                            Size.SM => UISettings.DpToUnityUnits(40.0f),
                            Size.MD => UISettings.DpToUnityUnits(44.0f),
                            Size.LG => UISettings.DpToUnityUnits(48.0f),
                            Size.XL => UISettings.DpToUnityUnits(52.0f),
                            _ => UISettings.DpToUnityUnits(4.0f)
                        };
                        rectTransform.sizeDelta = new Vector2(circleSize, circleSize);

                        _circularTrack.ratio = 1.0f;
                        _circularTrack.onion = true;
                        _circularTrack.onionWidth = _trackSize;
                        _circularTrack.cornersRounding = flatten ? 0f : _trackSize;
                        _circularIndicator.ratio = 1.0f;
                        _circularIndicator.onion = true;
                        _circularIndicator.onionWidth = _trackSize;
                        _circularIndicator.cornersRounding = flatten ? 0f : _trackSize;
                        break;
                }

            },data => data.size, data => data.flatten);
        }

        private void calculateProgress(float value)
        {
            // reset to full (100%)
            _trackStart = _indicatorStart = 0.0f;
            _trackEnd = _indicatorEnd = binder.data.shape == Shape.linear ? rectTransform.rect.width : 1.0f;

            switch (binder.data.shape)
            {
                case Shape.linear:
                    var size = rectTransform.rect.width;
                    if (Mathf.Approximately(value, 0.0f))
                    {
                        _trackStart = 0.0f;
                        _trackEnd = size;
                        _indicatorStart = _indicatorEnd = 0.0f;
                    }
                    else if (Mathf.Approximately(value, 1.0f))
                    {
                        _trackStart = _trackEnd = 0.0f;
                        _indicatorStart = 0.0f;
                        _indicatorEnd = size;
                    }
                    else
                    {
                        float inbetween = size * value;
                        _trackStart = Mathf.Min(size, inbetween + _gap);
                        _trackEnd = size - _trackStart;
                        _indicatorStart = 0.0f;
                        _indicatorEnd = Mathf.Max(0.0f, inbetween - _gap);
                    }
                    
                    break;
                case Shape.circular:
                    if (Mathf.Approximately(value, 0.0f))
                    {
                        _trackStart = 0.0f;
                        _trackEnd = 1.0f;
                        _indicatorStart = _indicatorEnd = 0.0f;
                    }
                    else if (Mathf.Approximately(value, 1.0f))
                    {
                        _trackStart = _trackEnd = 0.0f;
                        _indicatorStart = 0.0f;
                        _indicatorEnd = 1.0f;
                    }
                    else
                    {
                        var d = rectTransform.rect.width;
                        var chordLength = _gap / Mathf.Max(d, 1f);
                        var gapAngleDegrees = 2f * Mathf.Asin(chordLength) * Mathf.Rad2Deg;
                        var gapAngleRatio = gapAngleDegrees / 360f;

                        _trackStart = Mathf.Max(360f - Mathf.Clamp((360.0f * value) + 2f * gapAngleDegrees, 0f, 360f), 0f);
                        _trackEnd = Mathf.Max(1f - (value + gapAngleRatio * 4), 0f);
                        _indicatorStart = 0f;
                        _indicatorEnd = value;
                    }
                    break;
            }
        }

        private void setProgress(float value)
        {
            if (binder.data.intermediate)
            {
                if (value <= 0.5f)
                    {
                        var scaledValue = Mathf.Clamp01(value * 2f);
                        calculateProgress(scaledValue);
                        switch (binder.data.shape)
                        {
                            case Shape.linear:
                                _linearTrackRT.anchoredPosition = new Vector2(_trackStart, _linearTrackRT.anchoredPosition.y);
                                _linearTrackRT.sizeDelta = new Vector2(_trackEnd, _linearTrackRT.sizeDelta.y);
                                _linearIndicatorRT.anchoredPosition = new Vector2(_indicatorStart, _linearIndicatorRT.anchoredPosition.y);
                                _linearIndicatorRT.sizeDelta = new Vector2(_indicatorEnd, _linearIndicatorRT.sizeDelta.y);
                                LayoutRebuilder.MarkLayoutForRebuild(_linearTrackRT);
                                LayoutRebuilder.MarkLayoutForRebuild(_linearIndicatorRT);
                                break;
                            case Shape.circular:
                                _circularTrack.startAngle = _trackStart;
                                _circularTrack.fillAmount = _trackEnd;
                                _circularIndicator.startAngle = _indicatorStart;
                                _circularIndicator.fillAmount = _indicatorEnd;
                                break;
                        }
                    }
                    else
                    {

                        var scaledValue = Mathf.Clamp01((value - 0.5f) * 2f);
                        calculateProgress(scaledValue);
                        switch (binder.data.shape)
                        {
                            case Shape.linear:
                                _linearIndicatorRT.anchoredPosition = new Vector2(_trackStart, _linearTrackRT.anchoredPosition.y);
                                _linearIndicatorRT.sizeDelta = new Vector2(_trackEnd, _linearTrackRT.sizeDelta.y);
                                _linearTrackRT.anchoredPosition = new Vector2(_indicatorStart, _linearIndicatorRT.anchoredPosition.y);
                                _linearTrackRT.sizeDelta = new Vector2(_indicatorEnd, _linearIndicatorRT.sizeDelta.y);
                                LayoutRebuilder.MarkLayoutForRebuild(_linearTrackRT);
                                LayoutRebuilder.MarkLayoutForRebuild(_linearIndicatorRT);
                                break;
                            case Shape.circular:
                                _circularIndicator.startAngle = _trackStart;
                                _circularIndicator.fillAmount = _trackEnd;
                                _circularTrack.startAngle = _indicatorStart;
                                _circularTrack.fillAmount = _indicatorEnd;
                                break;
                        }
                    }
            }
            else
            {
                calculateProgress(value);
                switch (binder.data.shape)
                {
                    case Shape.linear:
                        _linearTrackRT.anchoredPosition = new Vector2(_trackStart, _linearTrackRT.anchoredPosition.y);
                        _linearTrackRT.sizeDelta = new Vector2(_trackEnd, _linearTrackRT.sizeDelta.y);
                        _linearIndicatorRT.anchoredPosition = new Vector2(_indicatorStart, _linearIndicatorRT.anchoredPosition.y);
                        _linearIndicatorRT.sizeDelta = new Vector2(_indicatorEnd, _linearIndicatorRT.sizeDelta.y);
                        LayoutRebuilder.MarkLayoutForRebuild(_linearTrackRT);
                        LayoutRebuilder.MarkLayoutForRebuild(_linearIndicatorRT);
                        break;
                    case Shape.circular:
                        _circularTrack.startAngle = _trackStart;
                        _circularTrack.fillAmount = _trackEnd;
                        _circularIndicator.startAngle = _indicatorStart;
                        _circularIndicator.fillAmount = _indicatorEnd;
                        break;
                }
            }
        }
    }
}
