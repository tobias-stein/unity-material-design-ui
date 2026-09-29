using Cysharp.Threading.Tasks;
using UnityEngine;

namespace mdu.ui.demo
{
    public class GridViewDemo : MonoBehaviour
    {
        public struct TestData
        {
            public int intValue;
            public float floatValue;
            public string stringValue;
            public TextAlignment enumValue;
        }


        [SerializeField] private Surface _surface;

        private GridView _gridView;

        public void Start()
        {
            GridView
                .builder<TestData>(_surface.rectTransform)
                .addColumn(data => data.intValue, GridViewColumn
                    .create("Hello Int")
                    .withPreferedWidth(100)
                    .build())
                .addColumn(data => data.floatValue, GridViewColumn
                    .create("Hello Float")
                    .withAlignment(GridViewColumn.Alignment.Center)
                    .withSortable(false)
                    .build())
                .addColumn(data => data.stringValue, GridViewColumn
                    .create("Hello String")
                    .withVisibility(false)
                    .build())
                .addColumn(data => data.enumValue, GridViewColumn
                    .create("Hello Enum")
                    .withAlignment(GridViewColumn.Alignment.Right)
                    .withPreferedWidth(100)
                    .build())
                .withItemHeight(28.0f)
                .withCellPadding(8)
                .withBorders(true)
                .withAlternatingRowBackground(true)
                .withDataSource(new TestData[]
                {
                    new TestData { intValue = 1, floatValue = 0.5f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 2, floatValue = 0.6f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 3, floatValue = 0.7f, stringValue = "!", enumValue = TextAlignment.Right },
                    new TestData { intValue = 4, floatValue = 0.8f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 5, floatValue = 0.9f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 6, floatValue = 1.0f, stringValue = null, enumValue = TextAlignment.Right },
                    new TestData { intValue = 11, floatValue = 0.15f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 12, floatValue = 0.16f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 13, floatValue = 0.17f, stringValue = "!", enumValue = TextAlignment.Right },
                    new TestData { intValue = 14, floatValue = 0.18f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 15, floatValue = 0.19f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 16, floatValue = 1.10f, stringValue = null, enumValue = TextAlignment.Right },
                    new TestData { intValue = 21, floatValue = 20.5f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 22, floatValue = 20.6f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 23, floatValue = 20.7f, stringValue = "!", enumValue = TextAlignment.Right },
                    new TestData { intValue = 24, floatValue = 20.8f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 25, floatValue = 20.9f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 26, floatValue = 21.0f, stringValue = null, enumValue = TextAlignment.Right },
                    new TestData { intValue = 211, floatValue = 30.15f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 212, floatValue = 30.16f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 213, floatValue = 30.17f, stringValue = "!", enumValue = TextAlignment.Right },
                    new TestData { intValue = 214, floatValue = 30.18f, stringValue = "Hello", enumValue = TextAlignment.Left },
                    new TestData { intValue = 215, floatValue = 30.19f, stringValue = "World", enumValue = TextAlignment.Center },
                    new TestData { intValue = 216, floatValue = 31.10f, stringValue = null, enumValue = TextAlignment.Right }
                })
                .buildAsync()
                .ContinueWith(instance =>
                {
                    _gridView = instance;
                    _gridView.rectTransform.sizeDelta = new Vector2(600, 400);
                })
                .Forget();
        }
    }
}