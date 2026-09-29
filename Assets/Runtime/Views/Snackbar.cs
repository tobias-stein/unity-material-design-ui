using System;
using Cysharp.Threading.Tasks;
using DG.Tweening;
using UnityEngine;
using UnityEngine.Events;

namespace mdu.ui
{
    [Serializable]
    public struct SnackbarData
    {
        public string text;
        public string actionTitle;
        public UnityEvent action;
        public bool closable;
        public Snackbar.Duration duration;
    }

    public class Snackbar : UIView<Snackbar, SnackbarData>
    {
        public enum Duration { Persistent, VeryShort, Short, Medium, Long }

        [SerializeField] private Duration _duration = Duration.Persistent;
        [SerializeField] private Text _text;
        [SerializeField] private Button _closeButton;
        [SerializeField] private Button _actionButton;
        [SerializeField] private LoadingIndicator _timeout;

        private float _timeoutValue;
        private Tweener _timeoutTween;
        

        public override void setupUI(UISettings uiSettings)
        {
            var onClick = new UnityEvent();
            onClick.AddListener(close);
            _closeButton.binder.updateField(data => data.onClick, onClick);
            _text.binder.updateField(data => data.colorRole, UISettings.ColorRole.InverseOnSurface);

            binder.bind(data => data.text, value => _text.binder.updateField(data => data.text, value));
            binder.bind(data => data.actionTitle, value => _actionButton.binder.updateField(data => data.text, string.IsNullOrWhiteSpace(value) ? "Action" : value));
            binder.bind(data => data.action, value =>
            {
                if (value != null)
                {
                    _actionButton.binder.updateField(data => data.onClick, value);
                }
                _actionButton.gameObject.SetActive(value != null || (!Application.isPlaying && !string.IsNullOrWhiteSpace(binder.data.actionTitle)));
            }, dependsOn: data => data.actionTitle);
            binder.bind(data => data.duration, vaue =>
            {
                _timeoutValue = _duration switch
                {
                    Duration.VeryShort => 1f,
                    Duration.Short => 3f,
                    Duration.Medium => 5f,
                    Duration.Long => 7f,
                    _ => 5f
                };

                _timeout.gameObject.SetActive(_duration != Duration.Persistent);
            });
            binder.bind(data => data.closable, value => _closeButton.gameObject.SetActive(value));
        }

        public override UniTask show()
        {
            _timeoutTween?.Kill();
            if (_duration != Duration.Persistent)
            {
                _timeoutTween = DOTween
                    .To(() => 1f, x => _timeout.binder.updateField(data => data.progress, x), 0f, _timeoutValue)
                    .SetEase(Ease.Linear)
                    .OnComplete(close);
            }

            return base.show();
        }

        public new void close()
        {
            base.close();
            Dispose();
        }

        public new void OnDestroy()
        {
            base.OnDestroy();
            _timeoutTween?.Kill();
        }
        
        public static void open(string text, Snackbar.Duration duration = Snackbar.Duration.Medium, bool closable = true)
        {
            openAsync(new SnackbarData
            {
                text = text,
                duration = duration,
                closable = closable
            })
            .ContinueWith(instance => instance.show())
            .Forget();
        }
    }
}