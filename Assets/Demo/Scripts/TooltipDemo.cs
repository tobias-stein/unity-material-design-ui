using UnityEngine;
using UnityEngine.EventSystems;

namespace mdu.ui.demo
{
    public class TooltipDemp : MonoBehaviour, IPointerClickHandler
    {
        [SerializeField] private RectTransform target;
        [SerializeField] private bool placeOnTarget = false;
        [SerializeField] private Tooltip.Position tooltipPosition;

        public void OnPointerClick(PointerEventData eventData)
        {
            if (placeOnTarget)
            {
                Tooltip.show("Title", "Hello Tooltip :)\nHello Tooltip :)\n\n\nHello Tooltip :) Hello Tooltip :) Hello Tooltip :)", target, tooltipPosition);
            }
            else
            {
                Tooltip.show("Hello Tooltip :)\nHello Tooltip :)\n\n\nHello Tooltip :) Hello Tooltip :) Hello Tooltip :)", eventData.pressPosition, tooltipPosition);
            }
        }
    }
}