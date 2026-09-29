using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;

namespace mdu.ui
{
    public class ViewManager : IDisposable
    {
        private readonly Stack<ViewContext> _viewStack = new Stack<ViewContext>(8);

        /// <summary>
        /// Gets the currently active (top) ViewContext.
        /// Can be null if the stack is empty.
        /// </summary>
        public ViewContext currentContext => _viewStack.Count > 0 ? _viewStack.Peek() : null;

        private ConcurrentDictionary<Type, ViewContext> _pendingViewContexts = new ConcurrentDictionary<Type, ViewContext>();

        private CancellationTokenSource _contextSwitchCTS = new CancellationTokenSource();

        public void Dispose()
        {
            _contextSwitchCTS.Cancel();
            _contextSwitchCTS.Dispose();
            _contextSwitchCTS = null;

            Debug.Log("Disposing ViewManager...");
            closeAll(true);
        }

        /// <summary>
        /// Pushes a new view onto the stack, creating a new ViewContext for it.
        /// This will become the new active context.
        /// </summary>
        /// <typeparam name="TView">The type of the view to instantiate and show.</typeparam>
        public async UniTask<TView> pushAsync<TView, TData>(TData? data = null, Func<TView, UniTask> postConstruct = null)
            where TView : UIView<TView, TData>
            where TData : struct
        {
            _contextSwitchCTS.Cancel();
            _contextSwitchCTS.Dispose();
            _contextSwitchCTS = new CancellationTokenSource();

            try
            {
                // Deactivate the current top view before pushing a new one.
                if (currentContext != null)
                {
                    await currentContext.setActive(false, false, _contextSwitchCTS.Token);
                }

                // reuse old context if, any
                if (!_pendingViewContexts.TryGetValue(typeof(TView), out var context))
                {
                    // create new context
                    context = new ViewContext();
                }
                _viewStack.Push(context);

                if (context.mainView == null)
                {
                    var viewInstance = await UIView<TView, TData>.create(null, data, postConstruct);
                    viewInstance.onClose += _ => pop();
                    context.setMainView(viewInstance);
                }
                else
                {
                    if (data.HasValue)
                    {
                        var viewInstance = context.mainView as TView;
                        if (data.HasValue)
                        {
                            _contextSwitchCTS.Token.ThrowIfCancellationRequested();
                            viewInstance.binder.data = data.Value;
                        }
                        if (postConstruct != null)
                        {
                            _contextSwitchCTS.Token.ThrowIfCancellationRequested();
                            await postConstruct.Invoke(viewInstance);
                        }
                    }
                }

                // activate new view context
                _contextSwitchCTS.Token.ThrowIfCancellationRequested();
                await context.setActive(true, false, _contextSwitchCTS.Token);

                return context.mainView as TView;
            }
            catch (OperationCanceledException)
            {

            }

            return null;
        }



        /// <summary>
        /// Closes the current top view, disposes its context (and all owned UI elements),
        /// and reactivates the next view on the stack.
        /// </summary>
        public async UniTask popAsync(bool disposeContext = false)
        {
            _contextSwitchCTS.Cancel();
            _contextSwitchCTS.Dispose();
            _contextSwitchCTS = new CancellationTokenSource();

            try
            {
                if (_viewStack.Count == 0)
                {
                    Debug.LogWarning("View stack is already empty. Cannot pop.");
                    return;
                }

                // Deactivate and dispose the current context
                ViewContext contextToPop = _viewStack.Pop();
                await contextToPop.setActive(false, disposeContext, _contextSwitchCTS.Token); // Animate out
                if (disposeContext)
                {
                    contextToPop.Dispose();
                }
                else
                {
                    _pendingViewContexts.AddOrUpdate(contextToPop.mainView.GetType(), contextToPop, (key, oldValue) => contextToPop);
                }

                // Reactivate the new top view
                if (currentContext != null)
                {
                    await currentContext.setActive(true, false, _contextSwitchCTS.Token);
                }
            }
            catch (OperationCanceledException)
            {
                
            }
        }

        public void push<TView, TData>(TData? data = null, Func<TView, UniTask> postConstruct = null)
            where TView : UIView<TView, TData>
            where TData : struct
        {
            pushAsync<TView, TData>(data, postConstruct).Forget();
        }
        
        public void pop(bool disposeContext = false)
        {
            popAsync(disposeContext).Forget();
        }

        /// <summary>
        /// Closes all views and clears the stack.
        /// </summary>
        public void closeAll(bool disposeContexts = false)
        {
            foreach (var context in _viewStack)
            {
                context.mainView?.Dispose();
                if (disposeContexts)
                {
                    context.Dispose();
                }
                else
                {
                    _pendingViewContexts.AddOrUpdate(context.mainView.GetType(), context, (key, oldValue) => context);   
                }
            }
            _viewStack.Clear();
        }
    }
}