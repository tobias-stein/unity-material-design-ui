namespace UnityEngine.UI
{
    [AddComponentMenu("Layout/HV Layout Group", 153)]
    public class HVLayoutGroup : HorizontalOrVerticalLayoutGroup
    {
        protected HVLayoutGroup() { }

        public bool IsVertical = true;

        public bool isVertical { get { return IsVertical; } set { SetProperty(ref IsVertical, value); } }

        public override void CalculateLayoutInputHorizontal()
        {
            base.CalculateLayoutInputHorizontal();
            CalcAlongAxis(0, IsVertical);
        }

        public override void CalculateLayoutInputVertical()
        {
            CalcAlongAxis(1, IsVertical);
        }

        public override void SetLayoutHorizontal() => SetChildrenAlongAxis(0, IsVertical);
        public override void SetLayoutVertical() => SetChildrenAlongAxis(1, IsVertical);
    }
}
