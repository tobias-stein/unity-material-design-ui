using System;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace mdu.ui
{
    [RequireComponent(typeof(Image))]
    public class Backdrop : MonoBehaviour, IPointerClickHandler
    {
        [SerializeField] private RectTransform rectTransform;
        
        public Action onClick;

        private Image _image;

        public Color color
        {
            get => _image != null ? _image.color : Color.black;
            set
            {
                if (_image == null)
                {
                    _image = GetComponent<Image>();
                }

                _image.color = value;
                _image.SetAllDirty();
            }
        }


        public void OnEnable()
        {
            // Center the anchor and pivot 
            rectTransform.anchorMin = new Vector2(0.5f, 0.5f);
            rectTransform.anchorMax = new Vector2(0.5f, 0.5f);
            rectTransform.pivot = new Vector2(0.5f, 0.5f);

            // Set the position to the center 
            rectTransform.anchoredPosition = Vector2.zero;

            // Set the size to the screen width and height 
            rectTransform.sizeDelta = new Vector2(Screen.width, Screen.height);

            if (Application.isPlaying)
            {
                UniTask.NextFrame().ContinueWith(() => rectTransform.anchoredPosition = -(rectTransform.parent.transform as RectTransform).anchoredPosition).Forget();
            }
        }

        public void OnPointerClick(PointerEventData eventData)
        {
            onClick?.Invoke();
        }
    }

    internal class UnityTask
    {
    }
}