using System;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.EventSystems;

namespace mdu.ui
{
    public class SliderHandle : UIBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler, IPointerMoveHandler
    {
        [SerializeField] private RectTransform _rectTransform0;
        [SerializeField] private RectTransform _rectTransform;
        [SerializeField] private SDFQuad _handle;
        [SerializeField] private Text _valueText;
        [SerializeField] private SDFQuad _valueContainer;

        public Action<PointerEventData> onMove;

        public RectTransform rectTransform => _rectTransform0;

        public Vector2 size
        {
            get => _rectTransform.sizeDelta;
            set
            {
                _rectTransform.sizeDelta = value;
            }
        }

        public Color color
        {
            get => _handle.fillColor;
            set
            {
                _handle.fillColor = value;
            }
        }

        public Color valueContainerColor
        {
            get => _valueContainer.fillColor;
            set
            {
                _valueContainer.fillColor = value;
            }
        }

        public RectTransform valueContainer => _valueContainer.rectTransform;
        public Text valueText => _valueText;

        public bool show
        {
            get => gameObject.activeSelf;
            set
            {
                gameObject.SetActive(value);
            }
        }

        #region IPOINTER & IDRAG

        private bool _dragging = false;
        public void OnPointerDown(PointerEventData eventData)
        {
            _dragging = true;
            onMove?.Invoke(eventData);
        }

        public void OnPointerUp(PointerEventData eventData)
        {
            OnPointerExit(eventData);
        }

        public void OnPointerExit(PointerEventData eventData)
        {
            if (_dragging)
            {
                onMove?.Invoke(eventData);
            }
            _dragging = false;
        }

        public void OnPointerMove(PointerEventData eventData)
        {
            if (_dragging)
            {
                onMove?.Invoke(eventData);
            }
        }

        #endregion
    }
}