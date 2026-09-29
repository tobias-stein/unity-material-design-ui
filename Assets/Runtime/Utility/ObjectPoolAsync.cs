using System;
using System.Collections.Generic;
using Cysharp.Threading.Tasks;

namespace mdu
{
    public class PoolAsync<T>
    {
        /// <summary>
        /// Our factory function
        /// </summary>
        protected Func<UniTask<T>> objectFactory;

        /// <summary>
        /// Our resetting function
        /// </summary>
        protected readonly Action<T> objectReset;

        /// <summary>
        /// A list of all m_Available items
        /// </summary>
        protected readonly List<T> available;

        /// <summary>
        /// A list of all items managed by the pool
        /// </summary>
        protected readonly List<T> pool;

        public int size => pool.Count;

        /// <summary>
        /// Create a new pool with a given number of starting elements
        /// </summary>
        /// <param name="factory">The function that creates pool objects</param>
        /// <param name="reset">Function to use to m_Reset items when retrieving from the pool</param>
        /// <param name="initialCapacity">The number of elements to seed the pool with</param>
        public PoolAsync(Func<UniTask<T>> factory, Action<T> reset = null, int initialCapacity = 0)
        {
            if (factory == null)
            {
                throw new ArgumentNullException("factory");
            }

            available = new List<T>();
            pool = new List<T>();
            objectFactory = factory;
            objectReset = reset;

            if (initialCapacity > 0)
            {
                grow(initialCapacity).Forget();
            }
        }

        /// <summary>
        /// Gets an item from the pool, growing it if necessary
        /// </summary>
        /// <returns></returns>
        public virtual UniTask<T> get() => get(objectReset);

        /// <summary>
        /// Gets an item from the pool, growing it if necessary, and with a specified m_Reset function
        /// </summary>
        /// <param name="resetOverride">A function to use to m_Reset the given object</param>
        public virtual async UniTask<T> get(Action<T> resetOverride)
        {
            if (available.Count == 0)
            {
                await grow(1);
            }
            if (available.Count == 0)
            {
                throw new InvalidOperationException("Failed to grow pool");
            }

            int itemIndex = available.Count - 1;
            T item = available[itemIndex];
            available.RemoveAt(itemIndex);

            if (resetOverride != null)
            {
                resetOverride(item);
            }

            return item;
        }

        /// <summary>
        /// Gets whether or not this pool contains a specified item
        /// </summary>
        public virtual bool contains(T pooledItem)
        {
            return pool.Contains(pooledItem);
        }

        /// <summary>
        /// Return an item to the pool
        /// </summary>
        public virtual void free(T pooledItem, bool addToPool = false)
        {
            if (pool.Contains(pooledItem))
            {
                if (!available.Contains(pooledItem))
                {
                    freeInternal(pooledItem);
                }
            }
            else
            {
                if (addToPool)
                {
                    pool.Add(pooledItem);
                    freeInternal(pooledItem);
                }
                else
                {
                    throw new InvalidOperationException("Trying to return an item to a pool that does not contain it: " + pooledItem + ", " + this);
                }
            }
        }

        /// <summary>
        /// Return all items to the pool
        /// </summary>
        public virtual void freeAll()
        {
            freeAll(null);
        }

        /// <summary>
        /// Returns all items to the pool, and calls a delegate on each one
        /// </summary>
        public virtual void freeAll(Action<T> preReturn)
        {
            for (int i = 0; i < pool.Count; ++i)
            {
                T item = pool[i];
                if (!available.Contains(item))
                {
                    if (preReturn != null)
                    {
                        preReturn(item);
                    }
                    freeInternal(item);
                }
            }
        }

        /// <summary>
        /// Grow the pool by a given number of elements
        /// </summary>
        public async UniTask grow(int amount)
        {
            for (int i = 0; i < amount; ++i)
            {
                await add();
            }
        }

        /// <summary>
        /// Returns an object to the m_Available list. Does not check for consistency
        /// </summary>
        protected virtual void freeInternal(T element)
        {
            available.Add(element);
        }

        /// <summary>
        /// Adds a new element to the pool
        /// </summary>
        protected virtual async UniTask<T> add()
        {
            T newElement = await objectFactory();
            pool.Add(newElement);
            available.Add(newElement);

            return newElement;
        }
    }
}