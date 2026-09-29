using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Threading;
using com.convalise.UnityMaterialSymbols;
using Cysharp.Threading.Tasks;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Pool;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct GridViewData
    {
        public float headerHeight;
        public float itemHeight;
        public int cellPadding;
        public bool alternatingRowBackground;
        public bool cellBorder;
    }

    
    public class GridView : UIComponent<GridView, GridViewData>
    {
        public sealed class Builder<TData>
        {
            private RectTransform _parent;
            private IList<TData> _dataSource;
            private HashSet<GridViewColumn> _columns;
            private float _itemHeight = 24.0f;
            private float _headerHeight = 32.0f;
            private int _cellPadding = 2;
            private bool _cellBorders = false;
            private bool _alternatingRowBackground = false;

            public Builder(RectTransform parent = null)
            {
                _parent = parent;
                _columns = new HashSet<GridViewColumn>();
            }

            public Builder<TData> addColumn<TValue>(Expression<Func<TData, TValue>> propertyExpression, GridViewColumn column)
            {
                column.key = getPropertyName(propertyExpression);
                _columns.Add(column);
                return this;
            }


            private static string getPropertyName<TValue>(Expression<Func<TData, TValue>> propertyExpression)
            {
                var expression = propertyExpression.Body;
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
            

            public Builder<TData> withDataSource(IList<TData> dataSource)
            {
                _dataSource = dataSource;
                return this;
            }

            public Builder<TData> withItemHeight(float itemHeight)
            {
                _itemHeight = itemHeight;
                return this;
            }

            public Builder<TData> withHeaderHeight(float headerHeight)
            {
                _headerHeight = headerHeight;
                return this;
            }

            public Builder<TData> withCellPadding(int cellPadding)
            {
                _cellPadding = cellPadding;
                return this;
            }

            public Builder<TData> withBorders(bool value)
            {
                _cellBorders = value;
                return this;
            }

            public Builder<TData> withAlternatingRowBackground(bool alternatingRowBackground)
            {
                _alternatingRowBackground = alternatingRowBackground;
                return this;
            }

            public UniTask<GridView> buildAsync()
            {
                return create(
                    _parent,
                    new GridViewData
                    {
                        itemHeight = _itemHeight,
                        headerHeight = _headerHeight,
                        cellPadding = _cellPadding,
                        alternatingRowBackground = _alternatingRowBackground,
                        cellBorder = _cellBorders
                    },
                    async instance =>
                    {
                        instance.columns = _columns.ToList();
                        instance.setDataSource(_dataSource ?? new List<TData>());
                    }
                );
            }

            public void update(GridView instance)
            {
                instance.columns = _columns.ToList();
                instance.setDataSource(_dataSource ?? new List<TData>());
            }
        }
        

        [SerializeField] private Scrollbar _headerHorizontal, _headerVertical, _contentHorizontal, _contentVertical;
        [SerializeField] private RectTransform _headerViewport, _contentViewport;

        [SerializeField] private LayoutElement _headerLayout;
        [SerializeField] private RectTransform _headerContent, _cellsContent;

        [SerializeField] private Image _headersBackground, _contentBackground;

        [SerializeField] private LoadingIndicator _loadingIndicator;

        private static GameObjectPool _rowPool;

        static GridView()
        {
            _rowPool = new GameObjectPool(
                poolId =>
                {
                    var row = new GameObject("GridViewRow");
                    var rectTransform = row.AddComponent<RectTransform>();
                    var layout = row.AddComponent<HorizontalLayoutGroup>();
                    layout.childForceExpandWidth = false;
                    layout.childForceExpandHeight = false;
                    layout.childControlWidth = false;
                    layout.childControlHeight = false;
                    layout.childScaleWidth = false;
                    layout.childScaleHeight = false;

                    var contentSizeFitter = row.AddComponent<ContentSizeFitter>();
                    contentSizeFitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
                    contentSizeFitter.horizontalFit = ContentSizeFitter.FitMode.PreferredSize;

                    return row;
                });
        }

        private CancellationTokenSource _renderRequestCTS;

        #region DATA BACKEND

        private const string ROW_ID_FIELD = "__rowId";
        private DataTable _data;
        private DataView _dataView;
        private Type _dataType;
        private List<MemberInfo> _dataInfo;

        // sort state
        private string _currentSortColumn;
        private bool _sortAscending;

        private Dictionary<Guid, RectTransform> _rows;
        private Queue<GameObject> _availableContentRows;

        private void setDataSource<TData>(IList<TData> dataSource)
        {
            var dataType = typeof(TData);

            clearContent();
            if (dataType != _dataType)
            {
                disposeAvailableContentRows();

                _dataType = dataType;
                _dataInfo = new List<MemberInfo>();
                _dataInfo.AddRange(_dataType.GetFields(BindingFlags.Public | BindingFlags.Instance));
                _dataInfo.AddRange(_dataType.GetProperties(BindingFlags.Public | BindingFlags.Instance));
                _data = new DataTable(_dataType.Name);
                _dataView = new DataView(_data);

                _currentSortColumn = null;
                _sortAscending = true;

                // define table schema
                foreach (var member in _dataInfo)
                {
                    if (member is PropertyInfo propertyInfo)
                    {
                        _data.Columns.Add(member.Name, Nullable.GetUnderlyingType(propertyInfo.PropertyType) ?? propertyInfo.PropertyType);
                    }
                    else if (member is FieldInfo fieldInfo)
                    {
                        _data.Columns.Add(member.Name, Nullable.GetUnderlyingType(fieldInfo.FieldType) ?? fieldInfo.FieldType);
                    }
                }
                _data.Columns.Add(ROW_ID_FIELD, typeof(Guid));
            }

            _data.Clear();

            // insert initial data to table
            addRows(dataSource);
        }
        
        #region DATA CRUD

        public void addRow<TData>(TData item) => addRows(new List<TData> { item });
        public void addRows<TData>(IList<TData> items)
        {
            if (typeof(TData) != _dataType)
            {
                throw new ArgumentException("DataType mismatch: Got " + typeof(TData).Name + " expected " + _dataType.Name);
            }

            foreach (TData item in items)
            {
                var values = new object[_dataInfo.Count + 1 /* row id */];
                for (int i = 0; i < _dataInfo.Count; i++)
                {
                    if (_dataInfo[i] is PropertyInfo propertyInfo)
                    {
                        values[i] = propertyInfo.GetValue(item);
                    }
                    else if (_dataInfo[i] is FieldInfo fieldInfo)
                    {
                        values[i] = fieldInfo.GetValue(item);
                    }
                }
                values[_dataInfo.Count] = Guid.NewGuid();
                _data.Rows.Add(values);
            }

            requestRender();
        }

        /// <summary>
        /// Updates an existing row at a specific index in the current view.
        /// </summary>
        public void updateRow<TData>(int rowIndex, TData newItemData)
        {
            if (typeof(TData) != _dataType)
            {
                throw new ArgumentException("DataType mismatch: Got " + typeof(TData).Name + " expected " + _dataType.Name);
            }

            if (rowIndex < 0 || rowIndex >= _dataView.Count)
            {
                return;
            }

            DataRow rowToUpdate = _dataView[rowIndex].Row;
            rowToUpdate.BeginEdit();
            for (int i = 0; i < _dataInfo.Count; i++)
            {
                if (_dataInfo[i] is PropertyInfo propertyInfo)
                {
                    rowToUpdate[_dataInfo[i].Name] = propertyInfo.GetValue(newItemData);
                }
                else if(_dataInfo[i] is FieldInfo fieldInfo)
                {
                    rowToUpdate[_dataInfo[i].Name] = fieldInfo.GetValue(newItemData);
                }
                
            }
            rowToUpdate.EndEdit();

            requestRender();
        }

        /// <summary>
        /// Deletes a row at a specific index in the current view.
        /// </summary>
        public void deleteRow(int rowIndex)
        {
            if (rowIndex < 0 || rowIndex >= _dataView.Count)
            {
                return;
            }
            
            _dataView[rowIndex].Row.Delete();
            _data.AcceptChanges();

            requestRender();
        }

        /// <summary>
        /// Clears all data from the table.
        /// </summary>
        public void clearAllRows()
        {
            _data.Clear();
            requestRender();
        }
    
        #endregion // DATA CRUD

        #endregion // DATA BACKEND

        public IReadOnlyList<GridViewColumn> columns { get; private set; }
        
        public static Builder<TData> builder<TData>(RectTransform parent = null) => new Builder<TData>(parent);

        public override void setupUI(UISettings uiSettings)
        {
            _contentHorizontal.onValueChanged.RemoveListener(syncHeadersHorizontalScroll);
            _contentHorizontal.onValueChanged.AddListener(syncHeadersHorizontalScroll);

            _headersBackground.color = uiSettings.getColor(UISettings.ColorRole.Surface);
            _contentBackground.color = uiSettings.getColor(UISettings.ColorRole.Surface);
            _headerHorizontal.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.SurfaceDim);
            _headerVertical.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.SurfaceDim);
            _contentHorizontal.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.SurfaceDim);
            _contentVertical.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.SurfaceDim);

            _headerHorizontal.handleRect.GetComponent<SDFQuad>().fillColor = uiSettings.getColor(UISettings.ColorRole.SurfaceBright);
            _headerVertical.handleRect.GetComponent<SDFQuad>().fillColor = uiSettings.getColor(UISettings.ColorRole.SurfaceBright);
            _contentHorizontal.handleRect.GetComponent<SDFQuad>().fillColor = uiSettings.getColor(UISettings.ColorRole.SurfaceBright);
            _contentVertical.handleRect.GetComponent<SDFQuad>().fillColor = uiSettings.getColor(UISettings.ColorRole.SurfaceBright);
            _headerHorizontal.handleRect.GetComponent<SDFQuad>().outlineColor = uiSettings.getColor(UISettings.ColorRole.Outline);
            _headerVertical.handleRect.GetComponent<SDFQuad>().outlineColor = uiSettings.getColor(UISettings.ColorRole.Outline);
            _contentHorizontal.handleRect.GetComponent<SDFQuad>().outlineColor = uiSettings.getColor(UISettings.ColorRole.Outline);
            _contentVertical.handleRect.GetComponent<SDFQuad>().outlineColor = uiSettings.getColor(UISettings.ColorRole.Outline);

            binder.bind(data => data.headerHeight, value =>
            {
                _headerLayout.preferredHeight = value;
                _contentVertical.handleRect.offsetMax = new Vector2(_contentVertical.handleRect.offsetMax.x, value + 10);

                requestRender();
            });

            binder.bind(data => data.itemHeight, value =>
            {
                requestRender();
            });

            binder.bind(data => data.alternatingRowBackground, value =>
            {
                requestRender();
            });

            binder.bind(data => data.cellPadding, value =>
            {
                requestRender();
            });
        }

        protected override void OnRectTransformDimensionsChange()
        {
            if (Application.isPlaying && columns != null && columns.Count > 0)
            {
                requestRender();
            }
        }

        public new void OnEnable()
        {
            base.OnEnable();

            requestRender();
        }

        public new void OnDisable()
        {
            _renderRequestCTS?.Cancel();
            _renderRequestCTS = null;

            base.OnDisable();
        }

        private void disposeAvailableContentRows()
        {
            if (_availableContentRows == null)
            {
                _availableContentRows = new Queue<GameObject>();
                return;
            }

            while(_availableContentRows.Count > 0)
            {
                var row = _availableContentRows.Dequeue().transform;
                for (int j = 0; j < row.childCount; ++j)
                {
                    var cell = row.GetChild(j).GetComponent<GridViewCell>();
                    cell.Dispose();

                }
                _rowPool.free(row.gameObject);
            }
            
            _availableContentRows.Clear();
        }


        private void requestRender()
        {
            //if(_renderRequestCTS == null)
            //{
                _renderRequestCTS?.Cancel();
                _renderRequestCTS = new CancellationTokenSource();
                renderAsync(_renderRequestCTS.Token).Forget();
            //}
        }

        private async UniTask renderAsync(CancellationToken cancellationToken = default)
        {
            // debounce
            //await UniTask.Delay(TimeSpan.FromMilliseconds(100), cancellationToken: cancellationToken);

            try
            {
                clearContent();
                cancellationToken.ThrowIfCancellationRequested();

                if (columns == null || columns.Count == 0)
                {
                    _renderRequestCTS = null;
                    return;
                }

                var gridHeight = rectTransform.rect.height;
                var headerHeight = _headerLayout.preferredHeight;
                var contentHeight = _dataView.Count * (binder.data.itemHeight > 0 ? binder.data.itemHeight : 24.0f);
                var willVerticalScroll = contentHeight + headerHeight > gridHeight;
                var verticalScrollbarWidth = willVerticalScroll ? (_contentVertical.transform as RectTransform).rect.width : 0.0f;

                // 1. Get the total available width from the viewport.
                var gridViewportWidth = rectTransform.rect.width - verticalScrollbarWidth;
                // Filter for only visible columns to avoid unnecessary calculations.
                var visibleColumns = columns.Where(c => c.isVisible).ToList();
                // 2. Calculate the total width consumed by columns with a preferred width.
                var totalPreferredWidth = visibleColumns.Where(c => c.preferedWidth > 0).Sum(c => c.preferedWidth);
                // 3. Count the number of "flexible" columns that will share the remaining space.
                var flexibleColumnCount = visibleColumns.Count(c => c.preferedWidth <= 0);
                // 4. Calculate the remaining width available for flexible columns.
                var remainingWidth = gridViewportWidth - totalPreferredWidth;
                // 5. Determine the width for each flexible column.
                // Ensure we don't divide by zero if there are no flexible columns.
                var equalCellWidth = (flexibleColumnCount > 0) ? remainingWidth / flexibleColumnCount : 0;
                // Ensure the calculated width is not negative if preferred widths exceed the viewport.
                equalCellWidth = Mathf.Max(50.0f, equalCellWidth);
                // 6. Calculate the final total content width. This should now correctly sum up all parts.
                var contentWidth = visibleColumns.Sum(c => c.preferedWidth > 0 ? c.preferedWidth : equalCellWidth);


                _headerContent.sizeDelta = new Vector2(contentWidth, headerHeight + (willVerticalScroll ? 1.0f : 0.0f));
                _cellsContent.sizeDelta = new Vector2(contentWidth, contentHeight);

                _rows = _rows ?? new Dictionary<Guid, RectTransform>();
                _rows.Clear();


                _contentViewport.GetComponent<CanvasGroup>().alpha = 0.0f;

                // headers
                var headerRow = _rowPool.get();
                headerRow.transform.SetParent(_headerContent, false);
                headerRow.name = "Header";

                for (int i = 0; i < columns.Count; ++i)
                {
                    var column = columns[i];

                    if (!column.isVisible)
                    {
                        continue;
                    }

                    await GridViewCell.create(
                        headerRow.transform,
                        new GridViewCellData
                        {
                            width = column.preferedWidth > 0 ? column.preferedWidth : equalCellWidth,
                            height = binder.data.headerHeight,
                            alignment = column.alignment,
                            columnKey = column.key,
                            showHighlight = false,
                            backgroundColor = UISettings.ColorRole.Surface,
                            padding = binder.data.cellPadding,
                            border = binder.data.cellBorder ? new GridViewCellData.Border(Vector4.one, UI.settings.getColor(UISettings.ColorRole.SurfaceDim)) : GridViewCellData.Border.none
                        },
                        async instance =>
                        {
                            instance.setContent(await column.headerRenderer.renderAsync(instance, column.displayName ?? column.key).AttachExternalCancellation(cancellationToken));
                            instance.name = column.displayName ?? column.key;
                            instance.binder.updateField(data => data.alignment, column.alignment);

                            if (column.isSortable)
                            {
                                // trigger sorting
                                instance.onCellClicked += () =>
                                {
                                    if (_currentSortColumn == column.key)
                                    {
                                        _sortAscending = !_sortAscending;
                                    }
                                    else
                                    {
                                        _currentSortColumn = column.key;
                                        _sortAscending = true;
                                    }

                                    // update sort
                                    _dataView.Sort = $"{_currentSortColumn} {(_sortAscending ? "ASC" : "DESC")}";

                                    using (ListPool<GridViewCell>.Get(out var cells))
                                    {
                                        headerRow.GetComponentsInChildren(cells);
                                        foreach (var cell in cells)
                                        {
                                            cell.binder.updateField(data => data.prefixIcon, new MaterialSymbolData('\0', false));
                                        }
                                    }

                                    if (_currentSortColumn == column.key)
                                    {
                                        instance.binder.updateField(data => data.prefixIconColor, UI.settings.getColor(UISettings.ColorRole.Primary));
                                        instance.binder.updateField(data => data.prefixIcon, _sortAscending ? MaterialSymbolIcon.ICON_ARROW_DROP_UP : MaterialSymbolIcon.ICON_ARROW_DROP_DOWN);
                                    }

                                    sortRows();
                                };
                            }
                        }
                    ).AttachExternalCancellation(cancellationToken);
                }

                // content
                var t0 = DateTime.UtcNow;
                for (int rowIndex = 0; rowIndex < _dataView.Count; ++rowIndex)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var rowData = _dataView[rowIndex];

                    // first try to recycle existing rows
                    if (_availableContentRows.TryDequeue(out var rowUI))
                    {
                        rowUI.name = $"Row {rowData[ROW_ID_FIELD]}";
                        _rows.Add((Guid)rowData[ROW_ID_FIELD], rowUI.transform as RectTransform);

                        for (int j = 0; j < columns.Count; ++j)
                        {
                            var column = columns[j];

                            if (!column.isVisible)
                            {
                                continue;
                            }

                            var cell = rowUI.transform.GetChild(j).GetComponent<GridViewCell>();
                            cell.binder.updateField(data => data.backgroundColor, binder.data.alternatingRowBackground
                                        ? (rowIndex % 2 == 0 ? UISettings.ColorRole.Surface : UISettings.ColorRole.Surface1)
                                        : UISettings.ColorRole.Surface);

                            column.contentRenderer.updateAsync(cell, rowData[column.key], cell.getContent());
                        }

                        rowUI.SetActive(true);
                        continue;
                    }

                    rowUI = _rowPool.get();
                    rowUI.transform.SetParent(_cellsContent, false);
                    rowUI.name = $"Row {rowData[ROW_ID_FIELD]}";

                    _rows.Add((Guid)rowData[ROW_ID_FIELD], rowUI.transform as RectTransform);
                    for (int j = 0; j < columns.Count; ++j)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var column = columns[j];

                        if (!column.isVisible)
                        {
                            continue;
                        }

                        await GridViewCell.create(
                            rowUI.transform,
                            new GridViewCellData
                            {
                                width = column.preferedWidth > 0 ? column.preferedWidth : equalCellWidth,
                                height = binder.data.itemHeight,
                                alignment = column.alignment,
                                columnKey = column.key,
                                showHighlight = false,
                                backgroundColor = binder.data.alternatingRowBackground
                                    ? (rowIndex % 2 == 0 ? UISettings.ColorRole.Surface : UISettings.ColorRole.Surface1)
                                    : UISettings.ColorRole.Surface,
                                padding = binder.data.cellPadding,
                                border = binder.data.cellBorder ? new GridViewCellData.Border(Vector4.one, UI.settings.getColor(UISettings.ColorRole.SurfaceDim)) : GridViewCellData.Border.none
                            },
                            async instance =>
                            {
                                instance.setContent(await column.contentRenderer.renderAsync(instance, rowData[column.key]));
                                instance.name = $"{column.displayName ?? column.key}";
                            }).AttachExternalCancellation(cancellationToken);
                    }
                }

                cancellationToken.ThrowIfCancellationRequested();

                LayoutRebuilder.ForceRebuildLayoutImmediate(_cellsContent);
                UniTask.NextFrame().ContinueWith(() => _contentViewport.GetComponent<CanvasGroup>().alpha = 1.0f).Forget();

                Debug.Log($"{_dataView.Count} rows created in {(DateTime.UtcNow - t0).TotalMilliseconds}ms.");
            }
            catch(OperationCanceledException)
            {
                // ignore
            }

            // allow next render request
            _renderRequestCTS = null;
        }
        
        private void sortRows()
        {
            for (int i = 0; i < _dataView.Count; i++)
            {
                if (_rows.TryGetValue((Guid)_dataView[i][ROW_ID_FIELD], out RectTransform rowTransform))
                {
                    rowTransform.SetSiblingIndex(i);
                }
            }
        }
        
        private void clearContent()
        {
            for (int i = 0; i < _headerContent.childCount; ++i)
            {
                var headerRow = _headerContent.GetChild(i);
                for (int j = 0; j < headerRow.childCount; ++j)
                {
                    var cell = headerRow.GetChild(j).GetComponent<GridViewCell>();
                    cell.Dispose();

                }
                _rowPool.free(headerRow.gameObject);
            }
            
            for(int i = 0; i < _cellsContent.childCount; ++i)
            {
                var contentRow = _cellsContent.GetChild(i);
                contentRow.gameObject.SetActive(false);
                _availableContentRows.Enqueue(contentRow.gameObject);
            }
        }
        
        private void syncHeadersHorizontalScroll(float value)
        {
            _headerHorizontal.value = value;
        }
    }
}