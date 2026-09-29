
using UnityEngine;

namespace mdu.ui
{
    public interface IUIComponent : IUI
    {
        int preCacheCount { get; }
    }

    public abstract class UIComponent<TComponent, TData> : UIBase<TComponent, TData>, IUIComponent
        where TComponent : UIComponent<TComponent, TData>
        where TData : struct
    {
        [SerializeField] private int _preCacheCount;

        public virtual int preCacheCount => _preCacheCount;
    }
}