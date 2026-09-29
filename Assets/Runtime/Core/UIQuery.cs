using System.Collections;
using System.Collections.Generic;
using System.Linq;

namespace mdu.ui
{

    public class UIQuery<T> : IEnumerable<T> where T : class, IUI
    {
        private readonly IEnumerable<T> _elements;

        public UIQuery(IEnumerable<T> elements)
        {
            _elements = elements;
        }

        public T First()
        {
            return _elements.FirstOrDefault();
        }

        public T AtIndex(int index)
        {
            return _elements.ElementAtOrDefault(index);
        }

        public List<T> ToList()
        {
            return _elements.ToList();
        }

        public IEnumerator<T> GetEnumerator()
        {
            return _elements.GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }
}