using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using UnityEngine.Assertions;

namespace mdu
{
    public interface IBinder
    {
        void clear();
        void refresh();
        void reset();
    }

    /// <summary>
    /// A performant data binding engine that connects properties of a data source
    /// to UI update actions without using reflection during updates.
    /// </summary>
    public class Binder<TData> : IBinder where TData : struct
    {
        /// <summary>
        /// A static, thread-safe cache for compiled expression getters and setters specific to the TData type.
        /// This ensures that the expensive compilation process happens only once per property, per type.
        /// </summary>
        private static class BinderCache
        {
            public static readonly ConcurrentDictionary<string, Func<TData, object>> Getters = new ConcurrentDictionary<string, Func<TData, object>>();
            public static readonly ConcurrentDictionary<string, Func<TData, object, TData>> Setters = new ConcurrentDictionary<string, Func<TData, object, TData>>();
        }
        
        public Action<TData> onBindingCompleted;
        public Action<TData, string> onBindingChanged;

        private TData _data, _initial;

        public TData data
        {
            get => _data;
            set
            {
                var oldData = _data;
                _data = value;
                foreach (var fieldName in _bindings.Keys)
                {
                    refreshBinding(fieldName);
                }

                onBindingCompleted?.Invoke(_data);
            }
        }
        
        // The actual bindings. Maps a property name to a list of actions.
        private readonly Dictionary<string, Action<object>> _bindings = new Dictionary<string, Action<object>>();

        // Value: A list of properties that DEPEND on the key (e.g., ["foo"]).
        private readonly Dictionary<string, List<string>> _dependencies = new Dictionary<string, List<string>>();


        public Binder(TData initial = default)
        {
            _initial = initial;
        }

        public void reset() => data = _initial;

        public void refresh()
        {
            foreach (var fieldName in _bindings.Keys)
            {
                refreshBinding(fieldName);
                if (_dependencies.TryGetValue(fieldName, out var dependentProperties))
                {
                    foreach (var dependentPropName in dependentProperties)
                    {
                        if (dependentPropName != fieldName) refreshBinding(dependentPropName);
                    }
                }
            }
        }

        private void refreshBinding(string propertyName)
        {
            if (BinderCache.Getters.TryGetValue(propertyName, out var getter) && _bindings.TryGetValue(propertyName, out var action))
            {
                action(getter(_data));
            }

            if (_dependencies.TryGetValue(propertyName, out var dependentProperties))
            {
                foreach (var dependentPropName in dependentProperties)
                {
                    if (dependentPropName != propertyName) refreshBinding(dependentPropName);
                }
            }
        }

        public void clear()
        {
            _bindings.Clear();
            _dependencies.Clear();
        }

        /// <summary>
        /// Updates a single field on the data source and triggers only the relevant UI bindings.
        /// This is the recommended way to update data for high performance.
        /// </summary>
        /// <example>
        /// binder.UpdateField(data => data.Health, newHealthValue);
        /// </example>
        public void updateField<TValue>(Expression<Func<TData, TValue>> propertyExpression, TValue newValue)
        {
            string propertyName = GetPropertyName(propertyExpression);
            var setter = BinderCache.Setters.GetOrAdd(propertyName, _ => CreateSetter(propertyExpression));

            _data = setter(_data, newValue);
            refreshBinding(propertyName);

            onBindingChanged?.Invoke(_data, propertyName);
        }

        /// <summary>
        /// Binds a UI update action to a property on the data source.
        /// </summary>
        public void bind<TValue>(Expression<Func<TData, TValue>> propertyExpression, Action<TValue> onUpdate, params Expression<Func<TData, object>>[] dependsOn)
        {
            string propertyName = GetPropertyName(propertyExpression);
            BinderCache.Getters.GetOrAdd(propertyName, _ => {
                var func = propertyExpression.Compile();
                return d => func(d); // Wrap to match the dictionary's signature
            });

            BinderCache.Setters.GetOrAdd(propertyName, _ => CreateSetter(propertyExpression));

            if (onUpdate != null)
            {
                _bindings[propertyName] = value => onUpdate((TValue)value);
            }
            else
            {
                _bindings.Remove(propertyName);
            }

            if (dependsOn != null)
            {
                foreach (var dependencyExpression in dependsOn)
                {
                    string dependsOnName = GetPropertyName(dependencyExpression);

                    // Safety Check: Ensure this new dependency doesn't create a circle.
                    if (checkCircularDependency(propertyName, dependsOnName))
                    {
                        throw new InvalidOperationException($"Circular dependency detected. Cannot make '{propertyName}' depend on '{dependsOnName}' as '{dependsOnName}' (or one of its dependencies) already depends on '{propertyName}'.");
                    }

                    if (!_dependencies.ContainsKey(dependsOnName))
                    {
                        _dependencies[dependsOnName] = new List<string>();
                    }
                    _dependencies[dependsOnName].Add(propertyName);
                }
            }
        }

        private bool checkCircularDependency(string dependent, string dependsOn)
        {
            // This helper function performs a Depth-First Search (DFS) to determine
            // if a path exists from a startNode to an endNode in the dependency graph.
            bool exists(string startNode, string endNode, HashSet<string> visitedNodes)
            {
                // Base case: If we've reached the target node, a path exists.
                if (startNode == endNode) return true;

                // Mark the current node as visited for this traversal to avoid getting stuck in cycles.
                visitedNodes.Add(startNode);

                // Check if the current node has any other properties that depend on it.
                if (_dependencies.TryGetValue(startNode, out var dependents))
                {
                    // Recursively check each dependent property (each "neighbor" node in the graph).
                    foreach (var neighbor in dependents)
                    {
                        if (!visitedNodes.Contains(neighbor))
                        {
                            if (exists(neighbor, endNode, visitedNodes))
                            {
                                // If a path is found from any neighbor, propagate the result up.
                                return true;
                            }
                        }
                    }
                }

                // If no path was found from this node or any of its children, return false.
                return false;
            }

            // A circular dependency is created if adding a new edge from 'dependsOn' to 'dependent'
            // completes a cycle. This can only happen if a path *already* exists from 'dependent' back to 'dependsOn'.
            // Therefore, we must search for a path starting from the 'dependent' property to find the 'dependsOn' property.
            return exists(dependent, dependsOn, new HashSet<string>());
        }

        private string GetPropertyName<TValue>(Expression<Func<TData, TValue>> expression) => GetMemberName(expression.Body);

        /// <summary>
        /// A robust helper to get the member name from an expression, handling implicit conversions.
        /// </summary>
        private string GetMemberName(Expression expression)
        {
            // First, check if it's a conversion (e.g., to object), and if so, get the underlying member.
            if (expression is UnaryExpression unaryExp && unaryExp.Operand is MemberExpression memberExpFromUnary)
            {
                return memberExpFromUnary.Member.Name;
            }
            // Otherwise, check if it's a direct member access.
            if (expression is MemberExpression memberExp)
            {
                return memberExp.Member.Name;
            }

            throw new InvalidExpressionException("Expression must be a property or field accessor (e.g., data => data.PropertyName)");
        }

        private Func<TData, object, TData> CreateSetter<TValue>(Expression<Func<TData, TValue>> propertyExpression)
        {
            var memberExpression = GetMemberNameExpression(propertyExpression.Body) as MemberExpression;
            Assert.IsNotNull(memberExpression);
            var member = memberExpression.Member;

            var sourceParam = Expression.Parameter(typeof(TData), "source");
            var valueParam = Expression.Parameter(typeof(object), "value");

            var bindings = typeof(TData).GetMembers(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => m.MemberType == MemberTypes.Field || (m.MemberType == MemberTypes.Property && ((PropertyInfo)m).CanWrite))
                .Select(m =>
                {
                    Expression valueToSet;
                    if (m.Name == member.Name)
                    {
                        Type memberType = m is PropertyInfo p ? p.PropertyType : (m is FieldInfo f ? f.FieldType : throw new InvalidOperationException());
                        valueToSet = Expression.Convert(valueParam, memberType);
                    }
                    else
                    {
                        valueToSet = Expression.MakeMemberAccess(sourceParam, m);
                    }
                    return Expression.Bind(m, valueToSet);
                });

            var memberInit = Expression.MemberInit(Expression.New(typeof(TData)), bindings);
            return Expression.Lambda<Func<TData, object, TData>>(memberInit, sourceParam, valueParam).Compile();
        }

        private Expression GetMemberNameExpression(Expression expression)
        {
            if (expression is MemberExpression) return expression;
            if (expression is UnaryExpression unary) return unary.Operand;
            return null;
        }
    }
}