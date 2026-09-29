using System.Collections.Generic;
using System.Linq;

namespace mdu
{
    public static class IEnumerableExtensions
    {
        public static IOrderedEnumerable<T> Shuffle<T>(this IEnumerable<T> enumerable) => enumerable.OrderBy(x => UnityEngine.Random.value);
    }
}