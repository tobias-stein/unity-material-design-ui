using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    [ExecuteInEditMode]
    public class GridViewCellImage : Image
    {
        [SerializeField] private GridViewCellData.Border _border;

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            // The base method generates the standard quad for the Image
            base.OnPopulateMesh(vh);

            var vertCount = vh.currentVertCount;
            if (vertCount == 0) return;

            for (int i = 0; i < vertCount; i++)
            {
                UIVertex vert = new UIVertex();
                vh.PopulateUIVertex(ref vert, i);

                vert.uv1 = _border.width;
                vert.tangent = _border.color;
                
                vh.SetUIVertex(vert, i);
            }
        }

#if UNITY_EDITOR
        // This is called when values are changed in the Inspector
        protected override void OnValidate()
        {
            base.OnValidate();
            SetVerticesDirty();
        }
#endif // UNITY_EDITOR

        // Public method to allow changing properties from other scripts
        public void SetBorders(GridViewCellData.Border border)
        {
            _border = border;
            SetVerticesDirty();
        }
    }
}