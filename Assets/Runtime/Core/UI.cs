using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
using Cysharp.Threading.Tasks;

#if UNITY_EDITOR
using UnityEditor;
#endif
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.EventSystems;
using UnityEngine.Pool;
using UnityEngine.UI;

namespace mdu.ui
{

    /// <summary>
    /// Note: Enum value order matters and determines render priority (z-index).
    /// </summary>
    public enum CanvasLayer
    {
        BACKGROUND = 0,
        DEFAULT,
        MENU,
        POPUP
    }

    public interface IUI : IDisposable
    {
        public bool isPooled { get; }
        public string id { get; }
        RectTransform rectTransform { get; }

        void Constructor();

        void setupUI(UISettings uISettings);
        void refresh();
#if UNITY_EDITOR
        void OnValidate();
#endif
    }

    [RequireComponent(typeof(RectTransform))]
    public abstract class UIBase<TUI, TData> : UIBehaviour, IUI
        where TUI : UIBase<TUI, TData>
        where TData : struct
    {
        [SerializeField] private TData _data;
        [SerializeField] private string _id;

        private static PoolAsync<TUI> _pool = new PoolAsync<TUI>(() => UI.Instantiate<TUI>(), instance => instance._isPooled = true);

        public bool _isPooled;
        private bool _constructorPending;

        public bool isPooled => _isPooled;

        public readonly Binder<TData> binder = new Binder<TData>();

        public string id => _id;

        public RectTransform rectTransform { get; private set; }

        public static UniTask<TUI> create(Transform parent = null, TData? data = null, Func<TUI, UniTask> postConstruct = null)
        {
            return _pool.get()
            .ContinueWith(async instance =>
            {
                await UniTask.SwitchToMainThread();

                UI.views?.currentContext?.register(instance);

                if (instance is not IView)
                {
                    var _parent = parent ?? UI.views?.currentContext?.mainView?.rectTransform;
                    if (_parent != null)
                    {
                        instance.rectTransform.SetParent(_parent, false);
                    }
                }

                instance.rectTransform.SetAsLastSibling();

                instance._isPooled = false;
                if (instance.gameObject != null)
                {
                    instance.gameObject.SetActive(true);
                }

                if (data.HasValue)
                {
                    instance.binder.data = data.Value;
                }

                return instance;
            })
            .ContinueWith(async instance =>
            {
                if (postConstruct != null)
                {
                    await postConstruct.Invoke(instance);
                }
                return instance;
            });
        }


        public virtual void Constructor()
        {
            try
            {
                if (UnityEngine.Application.isPlaying)
                {
#if UNITY_EDITOR
                    if (UnityEditor.PrefabUtility.IsPartOfPrefabAsset(gameObject))
                    {
                        return; // never set id for prefabs
                    }
#endif
                    _id = string.IsNullOrWhiteSpace(_id) ? Guid.NewGuid().ToString("N") : _id;
                }

                rectTransform = GetComponent<RectTransform>();

                binder.onBindingChanged = null;
                binder.onBindingCompleted = null;
                binder.clear();

                setupUI(UI.settings);

                //if (!UnityEngine.Application.isPlaying)
                {
                    // propagate value changes to the editor _data 
                    binder.onBindingChanged += (data, fieldName) =>
                    {
                        _data = data;
                    };
                    binder.onBindingCompleted += (data) => _data = data;
                }

                binder.data = _data;

                if (UnityEngine.Application.isPlaying)
                {
                    UI.invalidateCache();
                }
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogException(ex);
            }
        }

        public new void Awake()
        {
            base.Awake();
            UI.invalidateCache();
        }

        public new void OnDestroy()
        {
            base.OnDestroy();
            UI.invalidateCache();
        }

        public virtual void Dispose()
        {
            if (_isPooled) { return; }
            
            _pool.free((TUI)this, true);
            _isPooled = true;

            if (!IsDestroyed())
            {
                gameObject.SetActive(false);
            }
        }

        public virtual void refresh()
        {
            binder.refresh();
        }

        public abstract void setupUI(UISettings uISettings);


#if UNITY_EDITOR
        public new void OnValidate()
        {
            base.OnValidate();

            if (Application.isPlaying && PrefabUtility.IsPartOfPrefabAsset(gameObject))
            {
                return;
            }

            if (!_constructorPending)
            {
                _constructorPending = true;
                EditorApplication.delayCall += () =>
                {
                    _constructorPending = false;
                    if (this == null) { return; }
                    Constructor();
                };
            }
        }
#else
        public new void OnValidate()
        {
            base.OnValidate();
            Constructor();
        }
#endif
    }

    public sealed class UI : IDisposable
    {
        private readonly ViewManager _viewManager;
        private readonly Canvas[] _canvas;

        private readonly UISettings _settings;
        private readonly GameObject _uiRoot;
        internal readonly Dictionary<string, IUI> _uiElements;

        internal static UI _current = null;

        public static ViewManager views => _current?._viewManager;

        public static UISettings settings => UI._current?._settings
#if UNITY_EDITOR
            ?? UISettings.current
#endif
        ;

        private static bool _rebuildScheduled = false;
        private static CancellationTokenSource _cancellationTokenSource;


        private static readonly List<Type> _uiComponentTypes;

        static UI()
        {
            _uiComponentTypes = new List<Type>();
            foreach (Type type in Assembly.GetAssembly(typeof(IUIComponent)).GetTypes())
            {
                if (!type.IsAbstract && typeof(IUIComponent).IsAssignableFrom(type))
                {
                    _uiComponentTypes.Add(type);
                }
            }
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void InitializeOnLoad()
        {
            // Ensure our state is reset when scripts reload in the editor
            _cancellationTokenSource?.Cancel();
            _cancellationTokenSource = new CancellationTokenSource();
        }

        public UI(UISettings uiSettings)
        {
            _uiElements = new Dictionary<string, IUI>();
            _rebuildScheduled = false;
            _cancellationTokenSource = new CancellationTokenSource();
            _viewManager = new ViewManager();

            var canvasLayerNames = Enum.GetNames(typeof(CanvasLayer));

            this._canvas = new Canvas[canvasLayerNames.Length];
            this._settings = uiSettings;

            _uiRoot = new GameObject("UI");
            var uiDebug = _uiRoot.AddComponent<UIDebug>();
            uiDebug.uISettings = uiSettings;

            foreach (var layerName in canvasLayerNames)
            {
                var layerId = (int)Enum.Parse<CanvasLayer>(layerName);
                var canvasGO = new GameObject(layerName);
                canvasGO.transform.SetParent(_uiRoot.transform, false);

                var canvas = canvasGO.AddComponent<Canvas>();
                canvas.sortingOrder = layerId + 2 + 1;
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                canvas.pixelPerfect = true;
                canvas.additionalShaderChannels = AdditionalCanvasShaderChannels.None;

                var canvasScaler = canvasGO.AddComponent<CanvasScaler>();
                canvasScaler.uiScaleMode = CanvasScaler.ScaleMode.ConstantPixelSize;

                var graphicRaycaster = canvasGO.AddComponent<GraphicRaycaster>();
                graphicRaycaster.ignoreReversedGraphics = true;

                this._canvas[layerId] = canvas;
            }

            var _cachedUI = new GameObject("Cached UI Elements");
            var _cachedUITransform = _cachedUI.transform;
            _cachedUITransform.SetParent(_uiRoot.transform, false);
            _cachedUI.SetActive(false);

            foreach (var componentType in _uiComponentTypes)
            {
                UniTask.Post(async () =>
                {
                    var prefab = await Addressables.LoadAssetAsync<GameObject>(componentType.FullName).ToUniTask();
                    var preCacheCount = prefab.GetComponent<IUIComponent>().preCacheCount;

                    if(preCacheCount == 0)
                    {
                        return; 
                    }

                    var components = new List<IUI>();
                    for (int i = 0; i < preCacheCount; i++)
                    {
                        components.Add(create(prefab, _cachedUITransform));
                        await UniTask.Yield();
                    }

                    components.ForEach(comp => comp.Dispose());
                });
            }

            uiSettings.onChanged += applyUISettings;

            UI._current = this;
        }

        public void Dispose()
        {
            if(UI._current == null) { return; }
            UI._current._viewManager.Dispose();
            UI._current = null;
        }

        private void applyUISettings(UISettings uiSettings)
        {
            DateTime dt = DateTime.UtcNow;
            foreach (var ui in _uiElements.Values)
            {
                if(ui.isPooled) { continue; }

                ui.setupUI(uiSettings);
                ui.refresh();
            }
            Debug.Log($"UI: Rebuild of {_uiElements.Count(u => !u.Value.isPooled)} UI elements took {(DateTime.UtcNow - dt).TotalMilliseconds} ms");
        }

        public static void invalidateCache()
        {
            // If a rebuild is already scheduled for this frame, do nothing.
            if (UI._current == null || _rebuildScheduled)
            {
                return;
            }

            // Schedule the rebuild and start the async worker.
            _rebuildScheduled = true;
            invalidateCacheInternal(_cancellationTokenSource.Token).Forget();
        }

        private static async UniTaskVoid invalidateCacheInternal(CancellationToken token)
        {
            // Wait until all Update, etc. methods for this frame are complete.
            await UniTask.WaitForEndOfFrame(token);

            // If the task was cancelled (e.g., application quitting), stop here.
            if (token.IsCancellationRequested) return;

            _current._uiElements.Clear();

            // The 'true' argument includes inactive GameObjects in the search.
            using (ListPool<IUI>.Get(out var buffer))
            {
                _current._uiRoot.GetComponentsInChildren<IUI>(true, buffer);

                foreach (var element in buffer)
                {
                    // We check for the key just in case of any duplicate instances during the call.
                    if (!_current._uiElements.ContainsKey(element.id))
                    {
                        _current._uiElements.Add(element.id, element);
                    }
                    else
                    {
                        Debug.LogWarning($"UI element '{element}' ID '{element.id}' is not unique!");
#if UNITY_EDITOR
                        Selection.activeGameObject = element.rectTransform.gameObject;
                        Debug.Break();
#endif
                    }
                }
            }

            foreach (var layerId in Enum.GetValues(typeof(CanvasLayer)).Cast<int>())
            {
                var canvas = _current._canvas[layerId];
                canvas.sortingOrder = layerId + 2 + 1;
                canvas.additionalShaderChannels = AdditionalCanvasShaderChannels.None;
            }

            _rebuildScheduled = false;
        }

        public static async UniTask<T> Instantiate<T>(Transform parent = null) where T : IUI
        {
            await UniTask.SwitchToMainThread();

            if (!Application.isPlaying)
            {
                throw new System.Exception("Component can only be created dynamically at runtime!");
            }

            var prefab = await Addressables.LoadAssetAsync<GameObject>(typeof(T).FullName).ToUniTask();


            return (T)create(prefab, parent);
        }

        private static IUI create(GameObject prefab, Transform parent)
        {
            GameObject gameObject = null;
            if (prefab.TryGetComponent<IView>(out var view))
            {
                gameObject = GameObject.Instantiate(prefab, UI._current?._canvas[(int)view.layer].transform, false);
            }
            else
            {
                gameObject = GameObject.Instantiate(prefab, parent ?? UI._current?._canvas[(int)CanvasLayer.DEFAULT].transform, false);
            }

            construct(gameObject);

            return gameObject.GetComponent<IUI>();
        }

        private static void construct(GameObject gameObject)
        {
            if (gameObject == null) return;

            // first recursevly traverse down the hierarchy
            var transform = gameObject.transform;
            for (var i = 0; i < transform.childCount; i++)
            {
                var child = transform.GetChild(i);
                construct(child.gameObject);
            }

            // then call the Constructor
            if (gameObject.TryGetComponent<IUI>(out var uiElement))
            {
                uiElement.Constructor();
            }
        }

        /// <summary>
        /// Starts a new query from the UI root for elements of type T.
        /// This operation is very fast as it uses the pre-built cache.
        /// </summary>
        public static UIQuery<T> Query<T>() where T : class, IUI
        {
            if (UI._current == null)
            {
                throw new System.Exception("UI query works only at runtime!");
            }

            // OfType both filters for the correct type and casts the results.
            return new UIQuery<T>(_current._uiElements.Values.OfType<T>());
        }
    }

    public static class UIExtension
    {
        /// <summary>
        /// Starts a new query from a specific IUI parent element's transform.
        /// This operation is very fast as it filters the existing cache instead of
        /// calling GetComponentsInChildren.
        /// </summary>
        public static UIQuery<T> Query<T>(this IUI parent) where T : class, IUI
        {
            if (UI._current == null)
            {
                throw new System.Exception("UI query works only at runtime!");
            }
            
            var descendantElements = UI._current._uiElements.Values
                .Where(e => e != parent && e.rectTransform.IsChildOf(parent.rectTransform))
                .OfType<T>();

            return new UIQuery<T>(descendantElements);
        }
    }
}