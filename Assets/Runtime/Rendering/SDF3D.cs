using UnityEngine;

namespace mdu
{
    [RequireComponent(typeof(SpriteRenderer))]
    public class SDF3D : MonoBehaviour
    {
        public enum Shape
        {
            CIRCLE,
            ELLIPSE,
            RECTANGLE,
            HEXAGON,
            PENTAGON,
            EQ_TRIANGLE,
            ISO_TRIANGLE,
            RHOMBUS,
            ARC
        }

        [SerializeField] private SpriteRenderer _renderer;

        [SerializeField] private Shape _shape;
        [SerializeField] private Color _fillColor;
        [SerializeField] private Vector2 _size = new Vector2(0.25f, 0.25f);
        [SerializeField] private Vector4 _cornerRadius = Vector4.zero;

        [Range(0.0f, 1.0f)]
        [SerializeField] private float _arcLength = 0.5f;
        [Range(0.0f, 1.0f)]
        [SerializeField] private float _arcThickness = 0.5f;

        [Range(0.0f, 0.5f)]
        [SerializeField] private float _radius = 0.25f;

        [Range(0.0f, 0.5f)]
        [SerializeField] private float _outlineThickness = 0.0f;

        [Range(0.0f, 0.5f)]
        [SerializeField] private float _inlineThickness = 0.0f;

        [SerializeField] private Color _outlineColor;
        [SerializeField] private Color _inlineColor;


        private MaterialPropertyBlock _propertyBlock;


        public Shape shape
        {
            get => _shape;
            set
            {
                if (_shape == value) { return; }
                _shape = value;
                updateMaterialProperties();
            }
        }

        public Color fillColor
        {
            get => _fillColor;
            set
            {
                if (_fillColor == value) { return; }
                _fillColor = value;
                updateMaterialProperties();
            }
        }

        public Vector2 size
        {
            get => _size;
            set
            {
                if (_size == value) { return; }
                _size = value;
                updateMaterialProperties();
            }
        }

        public Vector4 cornerRadius
        {
            get => _cornerRadius;
            set
            {
                if (_cornerRadius == value) { return; }
                _cornerRadius = value;
                updateMaterialProperties();
            }
        }

        public float arcLegnth
        {
            get => _arcLength;
            set
            {
                if (_arcLength == value) { return; }
                _arcLength = value;
                updateMaterialProperties();
            }
        }

        public float arcThickness
        {
            get => _arcThickness;
            set
            {
                if (_arcThickness == value) { return; }
                _arcThickness = value;
                updateMaterialProperties();
            }
        }

        public float radius
        {
            get => _radius;
            set
            {
                if (_radius == value) { return; }
                _radius = value;
                updateMaterialProperties();
            }
        }

        public Color outlineColor
        {
            get => _outlineColor;
            set
            {
                if (_outlineColor == value) { return; }
                _outlineColor = value;
                updateMaterialProperties();
            }
        }

        public float outlineThickness
        {
            get => _outlineThickness;
            set
            {
                if (_outlineThickness == value) { return; }
                _outlineThickness = value;
                updateMaterialProperties();
            }
        }

        public Color inlineColor
        {
            get => _inlineColor;
            set
            {
                if (_inlineColor == value) { return; }
                _inlineColor = value;
                updateMaterialProperties();
            }
        }

        public float inlineThickness
        {
            get => _inlineThickness;
            set
            {
                if (_inlineThickness == value) { return; }
                _inlineThickness = value;
                updateMaterialProperties();
            }
        }

        public int sortOrder
        {
            get => _renderer.sortingOrder;
            set => _renderer.sortingOrder = value;
        }

        public void Awake()
        {
            updateMaterialProperties();
        }

#if UNITY_EDITOR
        private void OnValidate()
        {
            updateMaterialProperties();
        }
#endif

        private void updateMaterialProperties()
        {
            if (_propertyBlock == null)
            {
                _propertyBlock = _propertyBlock = new MaterialPropertyBlock();
            }

            _renderer.GetPropertyBlock(_propertyBlock);
            {
                _propertyBlock.SetFloat("_shape", (int)_shape);
                _propertyBlock.SetColor("_fillColor", _fillColor);

                _propertyBlock.SetVector("_size", new Vector4(_size.x, _size.y, 0.0f, 0.0f));
                _propertyBlock.SetFloat("_radius", _radius);
                _propertyBlock.SetVector("_cornerRadius", _cornerRadius);
                _propertyBlock.SetFloat("_arcLength", _arcLength);
                _propertyBlock.SetFloat("_arcThickness", _arcThickness);
                _propertyBlock.SetFloat("_outlineThickness", _outlineThickness);
                _propertyBlock.SetFloat("_inlineThickness", _inlineThickness);
                _propertyBlock.SetColor("_outlineColor", _outlineColor);
                _propertyBlock.SetColor("_inlineColor", _inlineColor);
            }
            _renderer.SetPropertyBlock(_propertyBlock);
        }
    }
}