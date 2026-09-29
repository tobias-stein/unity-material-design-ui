using System;
using Cysharp.Threading.Tasks;
    
namespace mdu.ui
{
    public enum ViewState { CREATED, VISIBLE, HIDDEN, DESTROYED }

    [Flags]
    public enum ViewTransition
    {
        NONE = 0,
        FADE = 1 << 0,
        SLIDE_X = 1 << 1,
        SLIDE_Y = 1 << 2,
        ZOOM = 1 << 3
    }

    public interface IView : IUI
    {
        event Action<IView> onShow, onHide, onClose;

        bool isStick { get; }

        CanvasLayer layer { get; }

        ViewTransition viewTransition { get; }

        UnityEngine.CanvasGroup canvasGroup { get; }
        UnityEngine.RectTransform rectTransform { get; }

        UniTask show();
        void hide();
        void close();
    }

    [UnityEngine.RequireComponent(typeof(UnityEngine.CanvasGroup))]
    public abstract class UIView<TView, TData> : UIBase<TView, TData>, IView
        where TView : UIView<TView, TData>
        where TData : struct
    {
        public static void open(TData? data = null, Func<TView, UniTask> postConstruct = null)
        {
            create(null, data, postConstruct).Forget();
        }

        public static async UniTask<TView> openAsync(TData? data = null, Func<TView, UniTask> postConstruct = null)
        {
            return await create(null, data, postConstruct);
        }
        
        public event Action<IView> onShow, onHide, onClose;

        [UnityEngine.SerializeField] private CanvasLayer _canvasLayer = CanvasLayer.DEFAULT;
        [UnityEngine.SerializeField] private ViewTransition _viewTransition = ViewTransition.FADE;
        [UnityEngine.SerializeField] private bool _isSticky = false;
        
        public CanvasLayer layer => _canvasLayer;
        public ViewTransition viewTransition => _viewTransition;

        private UnityEngine.CanvasGroup _canvasGroup = null;
        public UnityEngine.CanvasGroup canvasGroup
        {
            get
            {
                if (_canvasGroup == null)
                {
                    _canvasGroup = GetComponent<UnityEngine.CanvasGroup>();
                }

                return _canvasGroup;
            }
        }

        public bool isStick => _isSticky;

        private ViewState _state = ViewState.CREATED;

        public new void Awake()
        {
            base.Awake();

            _state = ViewState.CREATED;
            UnityEngine.Debug.Log($"{this} created.");
        }

        public virtual UniTask show()
        {
            if (_isSticky && _state == ViewState.VISIBLE) { return UniTask.CompletedTask; }

            gameObject.SetActive(true);
            UnityEngine.UI.LayoutRebuilder.ForceRebuildLayoutImmediate(rectTransform);

            _state = ViewState.VISIBLE;
            UnityEngine.Debug.Log($"{this} shown.");
            onShow?.Invoke(this);

            return UniTask.CompletedTask;
        }

        /// <summary>
        /// Called by view manager.
        /// </summary>
        public virtual void hide()
        {
            if(_isSticky) { return; }

            gameObject.SetActive(false);

            _state = ViewState.HIDDEN;
            UnityEngine.Debug.Log($"{this} hidden.");
            onHide?.Invoke(this);
        }

        public virtual void close()
        {
            onClose?.Invoke(this);
        }

        public override void Dispose()
        {
            base.Dispose();
            
            onShow = onHide = onClose = null;

            UnityEngine.Debug.Log($"{this} destroyed.");
            _state = ViewState.DESTROYED;
        }
    }
}