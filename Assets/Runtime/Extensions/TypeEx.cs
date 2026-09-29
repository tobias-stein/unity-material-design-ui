using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace mdu
{
    /// <summary>
    /// This class provides extension methods for the System.Type class.
    /// </summary>
    public static class TypeEx
    {
        /// <summary>
        /// Helper method to get all public and private methods of a class type (including parent classes).
        /// </summary>
        /// <returns></returns>
        public static IEnumerable<MethodInfo> GetAllMethodsInClassHierachy(this Type InType, Type InRootParentClass = null)
        {
            // grab all methods
            IEnumerable<MethodInfo> methods = InType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            // do it recursevly for parent classes
            if (InType.BaseType != InRootParentClass) { methods = methods.Concat(InType.BaseType.GetAllMethodsInClassHierachy(InRootParentClass)); }
            // return all found methods
            return methods;
        }
    }
}