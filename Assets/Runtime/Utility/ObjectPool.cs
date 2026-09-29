using System;
using System.Collections.Generic;
using UnityEngine;

namespace mdu
{
    public class Pool<T>
    {
        /// <summary>
        /// Our factory function
        /// </summary>
        protected Func<int, T> objectFactory;

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
        public Pool(Func<int, T> factory, Action<T> reset, int initialCapacity)
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
                grow(initialCapacity);
            }
        }

        /// <summary>
        /// Creates a new blank pool
        /// </summary>
        /// <param name="factory">The function that creates pool objects</param>
        public Pool(Func<int, T> factory)
            : this(factory, null, 0)
        {
        }

        /// <summary>
        /// Create a new pool with a given number of starting elements
        /// </summary>
        /// <param name="factory">The function that creates pool objects</param>
        /// <param name="initialCapacity">The number of elements to seed the pool with</param>
        public Pool(Func<int, T> factory, int initialCapacity)
            : this(factory, null, initialCapacity)
        {
        }

        /// <summary>
        /// Gets an item from the pool, growing it if necessary
        /// </summary>
        /// <returns></returns>
        public virtual T get()
        {
            return get(objectReset);
        }

        /// <summary>
        /// Gets an item from the pool, growing it if necessary, and with a specified m_Reset function
        /// </summary>
        /// <param name="resetOverride">A function to use to m_Reset the given object</param>
        public virtual T get(Action<T> resetOverride)
        {
            if (available.Count == 0)
            {
                grow(1);
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
        public virtual void free(T pooledItem)
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
                throw new InvalidOperationException("Trying to return an item to a pool that does not contain it: " + pooledItem + ", " + this);
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
        public void grow(int amount)
        {
            for (int i = 0; i < amount; ++i)
            {
                add();
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
        protected virtual T add()
        {
            T newElement = objectFactory(pool.Count);
            pool.Add(newElement);
            available.Add(newElement);

            return newElement;
        }
    }

    public class GameObjectPool : Pool<GameObject>
	{
		/// <summary>
		/// Create a new pool with a given number of starting elements
		/// </summary>
		/// <param name="factory">The function that creates pool objects</param>
		/// <param name="reset">Function to use to reset items when retrieving from the pool</param>
		/// <param name="initialCapacity">The number of elements to seed the pool with</param>
		public GameObjectPool(Func<int, GameObject> factory, Action<GameObject> reset, int initialCapacity)
			: base(factory, reset, initialCapacity)
		{
		}

		/// <summary>
		/// Creates a new blank pool
		/// </summary>
		/// <param name="factory">The function that creates pool objects</param>
		public GameObjectPool(Func<int, GameObject> factory)
			: base(factory)
		{
		}

		/// <summary>
		/// Create a new pool with a given number of starting elements
		/// </summary>
		/// <param name="factory">The function that creates pool objects</param>
		/// <param name="initialCapacity">The number of elements to seed the pool with</param>
		public GameObjectPool(Func<int, GameObject> factory, int initialCapacity)
			: base(factory, initialCapacity)
		{
		}

		/// <summary>
		/// Retrieve an enabled element from the pool
		/// </summary>
		public override GameObject get(Action<GameObject> resetOverride)
		{
			GameObject element = base.get(resetOverride);

			element.SetActive(true);

			return element;
		}

		/// <summary>
		/// Automatically disable returned object
		/// </summary>
		protected override void freeInternal(GameObject element)
		{
			element.SetActive(false);

			base.freeInternal(element);
		}

		/// <summary>
		/// Keep newly created objects disabled
		/// </summary>
		protected override GameObject add()
		{
			GameObject newElement = base.add();

			newElement.SetActive(false);

			return newElement;
		}
	}
}