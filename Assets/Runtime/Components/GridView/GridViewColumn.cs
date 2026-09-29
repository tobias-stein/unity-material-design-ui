
using System;

namespace mdu.ui
{
    public class GridViewColumn : IEquatable<GridViewColumn>
    {
        public sealed class Builder
        {
            private readonly GridViewColumn _columnDefinition;

            public Builder(string columnName)
            {
                _columnDefinition = new GridViewColumn();
                _columnDefinition.displayName = columnName ?? "";
                _columnDefinition.isVisible = true;
            }

            public Builder withPreferedWidth(float preferedWidth)
            {
                _columnDefinition.preferedWidth = preferedWidth;
                return this;
            }

            public Builder withVisibility(bool isVisible)
            {
                _columnDefinition.isVisible = isVisible;
                return this;
            }

            public Builder withSortable(bool isSortable)
            {
                _columnDefinition.isSortable = isSortable;
                return this;
            }

            public Builder withAlignment(Alignment alignment)
            {
                _columnDefinition.alignment = alignment;
                return this;
            }

            public Builder withHeaderRenderer(IGridViewCellRenderer headerRenderer)
            {
                _columnDefinition.headerRenderer = headerRenderer;
                return this;
            }
            
            public Builder withContentRenderer(IGridViewCellRenderer cellRenderer)
            {
                _columnDefinition.contentRenderer = cellRenderer;
                return this;
            }

            public GridViewColumn build()
            {
                if (_columnDefinition.headerRenderer == null)
                {
                    _columnDefinition.headerRenderer = new DefaultGridViewCellHeaderRenderer();
                }

                if (_columnDefinition.contentRenderer == null)
                {
                    _columnDefinition.contentRenderer = new DefaultGridViewCellContentRenderer();
                }

                return _columnDefinition;
            }
        }

        public enum Alignment { Left, Center, Right }

        public string key { get; set; }
        public string displayName { get; set; }
        public float preferedWidth { get; set; } 
        public bool isVisible { get; set; }
        public bool isSortable { get; set; }
        public Alignment alignment { get; set; }

        public IGridViewCellRenderer headerRenderer { get; set; }
        public IGridViewCellRenderer contentRenderer { get; set; }

        public bool Equals(GridViewColumn other) => key == other.key;
        public override bool Equals(object obj) => obj is GridViewColumn other && Equals(other);
        public override int GetHashCode() => key.GetHashCode();

        private GridViewColumn()
        {
            alignment = Alignment.Left;
            preferedWidth = 0;
            isVisible = true;
            isSortable = true;
        }

        public static Builder create(string name) => new Builder(name);
    }
}