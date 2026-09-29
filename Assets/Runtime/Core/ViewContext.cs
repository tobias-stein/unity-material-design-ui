using System;
using System.Collections.Generic;
using System.Threading;
using Cysharp.Threading.Tasks;
using DG.Tweening;

namespace mdu.ui
{
    public class ViewContext : IDisposable
    {
        public IView mainView { get; private set; }

        private readonly List<IUI> _ownedElements = new List<IUI>();

        internal void setMainView(IView mainView)
        {
            this.mainView = mainView;
        }

        internal void register(IUI uiElement)
        {
            if (uiElement != null && !_ownedElements.Contains(uiElement))
            {
                _ownedElements.Add(uiElement);
            }
        }

        internal async UniTask setActive(bool isActive, bool dispose = false, CancellationToken token = default)
        {
            if (mainView != null)
            {
                DOTween.Kill(mainView.rectTransform, complete: false);
            }

            if (isActive)
            {
                var tween = mainView.transitionIn();

                if (tween != null)
                {
                    tween.SetTarget(mainView.rectTransform);
                    tween.OnStart(async () =>
                    {
                        try
                        {
                            await mainView.show().AttachExternalCancellation(token);
                        }
                        catch (OperationCanceledException)
                        {
                        }
                    });
                    var tcs = new UniTaskCompletionSource();
                    tween.OnComplete(() => tcs.TrySetResult());
                    token.Register(() => tcs.TrySetCanceled());
                    await tcs.Task;
                }
                else
                {
                    try
                    {
                        await mainView.show().AttachExternalCancellation(token);
                    }
                    catch (OperationCanceledException)
                    {
                    }
                }
            }
            else
            {
                var tween = mainView.transitionOut();
                if (tween != null)
                {
                    tween.SetTarget(mainView.rectTransform);
                    tween.OnComplete(() =>
                    {
                        mainView.hide();
                        if (dispose)
                        {
                            mainView.Dispose();
                        }
                    });
                    var tcs = new UniTaskCompletionSource();
                    tween.OnComplete(() => tcs.TrySetResult());
                    token.Register(() => tcs.TrySetCanceled());
                    await tcs.Task;
                }
                else
                {
                    mainView.hide();
                    if (dispose)
                    {
                        mainView.Dispose();
                    }
                }
            }
        }

        public void Dispose()
        {
            if (mainView != null && mainView.rectTransform != null)
            {
                DOTween.Kill(mainView.rectTransform);
            }

            for (int i = _ownedElements.Count - 1; i >= 0; i--)
            {
                _ownedElements[i]?.Dispose();
            }
            _ownedElements.Clear();
        }
    }
}
