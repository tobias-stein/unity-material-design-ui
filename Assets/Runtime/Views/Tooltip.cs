using System;
using System.Collections.Generic;
using Cysharp.Threading.Tasks;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct TooltipData
    {
        public string title;
        [TextArea] public string text;
        public Tooltip.Position anchor;
        public RectTransform target;
        public Vector2 position;
        public UnityEvent onClose;
        public bool noBackground;
    }

    public class Tooltip : UIView<Tooltip, TooltipData>
    {
        private const float MAX_TOOLTIP_WIDTH = 400.0f;
        private const float TOOLTIP_MARGIN = 8.0f;

        public enum Position
        {
            TOP_LEFT,
            TOP,
            TOP_RIGHT,
            RIGHT,
            BOTTOM_RIGHT,
            BOTTOM,
            BOTTOM_LEFT,
            LEFT,
            CENTER
        }

        [SerializeField] private SDFQuad _sdf;
        [SerializeField] private Backdrop _backdrop;
        [SerializeField] private Text _title;
        [SerializeField] private Text _supportText;
        [SerializeField] private LayoutElement _supportTextLayout;
        [SerializeField] private RectTransform _extra;


        public static void show(string text, Vector3 position, Tooltip.Position anchor = Position.TOP_LEFT, Func<UniTask<IUI>> addExtra = null)
        {
            open(new TooltipData
            {
                text = text,
                target = null,
                position = position,
                anchor = anchor
            },
            async instance =>
            {
                if (addExtra != null)
                {
                    var content = await addExtra.Invoke();
                    content.rectTransform.SetParent(instance._extra, false);
                    LayoutRebuilder.ForceRebuildLayoutImmediate(instance.rectTransform);
                    instance.updateTooltip();
                }
            });
        }

        public static void show(
            string title,
            string text,
            RectTransform target,
            Tooltip.Position anchor = Position.TOP_LEFT,
            Func<UniTask<IUI>> addExtra = null,
            UnityEvent onClose = null,
            bool noBackground = false
        )
        {
            open(new TooltipData
            {
                text = text,
                target = target,
                anchor = anchor,
                onClose = onClose,
                noBackground = noBackground
            },
            async instance =>
            {
                for (var i = 0; i < instance._extra.childCount; ++i)
                {
                    instance._extra.GetChild(i).GetComponent<IUI>().Dispose();  
                }
                
                if (addExtra != null)
                {
                    var content = await addExtra.Invoke();
                    content.rectTransform.SetParent(instance._extra, false);
                    LayoutRebuilder.ForceRebuildLayoutImmediate(instance.rectTransform);
                    instance.updateTooltip();
                }
            });
        }

        public override void setupUI(UISettings uISettings)
        {
            _sdf = GetComponent<SDFQuad>();

            _sdf.fillColor = uISettings.getColor(UISettings.ColorRole.SurfaceVariant);
            _sdf.shadow = true;
            _sdf.shadowColor = uISettings.getColor(UISettings.ColorRole.Shadow);
            _sdf.shadowWidth = 2;
            _sdf.shadowOffset = new Vector2(0.0f, -2.0f);
            _sdf.shadowSoftness = 1.0f;
            _sdf.shadowInnerSoftWidth = 8.0f;

            _backdrop.onClick = () =>
            {
                close();

                binder.data.onClose?.Invoke();

                // simulate a second click at the same position of the the backdrop is gone
                var position = Pointer.current.position.ReadValue();
                UniTask.NextFrame().ContinueWith(() => simulateClick(position));
            };

            binder.bind(data => data.title, value =>
            {
                _title.binder.updateField(data => data.text, value);
                _title.gameObject.SetActive(!string.IsNullOrWhiteSpace(value));
            });

            binder.bind(data => data.text, value =>
            {
                _supportTextLayout.preferredWidth = -1f;
                LayoutRebuilder.ForceRebuildLayoutImmediate(rectTransform);

                _supportText.binder.updateField(data => data.text, value);
                _supportText.gameObject.SetActive(!string.IsNullOrWhiteSpace(value));

                _supportTextLayout.preferredWidth = _supportText.rectTransform?.rect.width > MAX_TOOLTIP_WIDTH ? MAX_TOOLTIP_WIDTH : -1;
                LayoutRebuilder.ForceRebuildLayoutImmediate(rectTransform);
            });
            binder.bind(data => data.noBackground, value => _sdf.enabled = !value);

            binder.onBindingCompleted += data => updateTooltip();
        }

        private void updateTooltip()
        {
            if (binder.data.target != null)
            {
                transform.position = calculateTooltipPosition(binder.data.target, binder.data.anchor);
            }
            else
            {
                transform.position = calculateTooltipPosition(binder.data.position, binder.data.anchor);
            }

            keepInScreenBounds();
        }

        /// <summary>
        /// Calculates the tooltip's world position based on a target RectTransform.
        /// </summary>
        private Vector3 calculateTooltipPosition(RectTransform target, Position position)
        {
            Vector3[] targetCorners = new Vector3[4];
            target.GetWorldCorners(targetCorners); // 0: BL, 1: TL, 2: TR, 3: BR

            return calculateFinalPosition(targetCorners, position);
        }

        /// <summary>
        /// Calculates the tooltip's world position based on a single world-space point (e.g., the mouse).
        /// </summary>
        private Vector3 calculateTooltipPosition(Vector3 targetPoint, Position position)
        {
            // Treat the single point as a zero-sized RectTransform
            Vector3[] targetCorners = { targetPoint, targetPoint, targetPoint, targetPoint };

            return calculateFinalPosition(targetCorners, position);
        }

        /// <summary>
        /// The core positioning logic, agnostic of the target type.
        /// </summary>
        private Vector3 calculateFinalPosition(Vector3[] targetCorners, Position position)
        {
            Vector3[] tooltipCorners = new Vector3[4];
            rectTransform.GetWorldCorners(tooltipCorners);

            float tooltipWidth = tooltipCorners[2].x - tooltipCorners[0].x;
            float tooltipHeight = tooltipCorners[1].y - tooltipCorners[3].y;

            float halfTooltipWidth = tooltipWidth / 2f;
            float halfTooltipHeight = tooltipHeight / 2f;

            // Calculate pivot-aware offsets for alignment
            float tooltipPivotOffsetX = halfTooltipWidth - (tooltipWidth * rectTransform.pivot.x);
            float tooltipPivotOffsetY = halfTooltipHeight - (tooltipHeight * rectTransform.pivot.y);

            // Target properties
            float targetWidth = targetCorners[2].x - targetCorners[1].x;
            float halfTargetWidth = targetWidth / 2f;

            float targetHeight = targetCorners[1].y - targetCorners[0].y;
            float halfTargetHeight = targetHeight / 2f;

            Vector3 newPos;

            switch (position)
            {
                case Position.TOP:
                    newPos = new Vector3(targetCorners[1].x + halfTargetWidth - tooltipPivotOffsetX, targetCorners[1].y + halfTooltipHeight + TOOLTIP_MARGIN, 0);
                    break;
                case Position.TOP_RIGHT:
                    newPos = new Vector3(targetCorners[2].x + halfTooltipWidth + TOOLTIP_MARGIN, targetCorners[2].y + halfTooltipHeight + TOOLTIP_MARGIN, 0);
                    break;
                case Position.RIGHT:
                    newPos = new Vector3(targetCorners[3].x + halfTooltipWidth + TOOLTIP_MARGIN, targetCorners[3].y + halfTargetHeight - tooltipPivotOffsetY, 0);
                    break;
                case Position.BOTTOM_RIGHT:
                    newPos = new Vector3(targetCorners[3].x + halfTooltipWidth + TOOLTIP_MARGIN, targetCorners[3].y - halfTooltipHeight - TOOLTIP_MARGIN, 0);
                    break;
                case Position.BOTTOM:
                    newPos = new Vector3(targetCorners[0].x + halfTargetWidth - tooltipPivotOffsetX, targetCorners[0].y - halfTooltipHeight - TOOLTIP_MARGIN, 0);
                    break;
                case Position.BOTTOM_LEFT:
                    newPos = new Vector3(targetCorners[0].x - halfTooltipWidth - TOOLTIP_MARGIN, targetCorners[0].y - halfTooltipHeight - TOOLTIP_MARGIN, 0);
                    break;
                case Position.LEFT:
                    newPos = new Vector3(targetCorners[0].x - halfTooltipWidth - TOOLTIP_MARGIN, targetCorners[0].y + halfTargetHeight - tooltipPivotOffsetY, 0);
                    break;
                case Position.TOP_LEFT:
                    newPos = new Vector3(targetCorners[1].x - halfTooltipWidth - TOOLTIP_MARGIN, targetCorners[1].y + halfTooltipHeight + TOOLTIP_MARGIN, 0);
                    break;
                case Position.CENTER:
                    newPos = new Vector3(targetCorners[0].x + halfTargetWidth - tooltipPivotOffsetX, targetCorners[0].y + halfTargetHeight - tooltipPivotOffsetY, 0);
                    break;
                default:
                    newPos = Vector3.zero;
                    break;
            }

            return newPos;
        }

        private void keepInScreenBounds()
        {
            Vector3[] corners = new Vector3[4];
            rectTransform.GetWorldCorners(corners);

            float minX = TOOLTIP_MARGIN;
            float maxX = Screen.width - TOOLTIP_MARGIN;
            float minY = TOOLTIP_MARGIN;
            float maxY = Screen.height - TOOLTIP_MARGIN;

            // Check and adjust horizontal position
            if (corners[2].x > maxX) // Right edge is off-screen
            {
                transform.position += Vector3.left * (corners[2].x - maxX);
            }
            else if (corners[0].x < minX) // Left edge is off-screen
            {
                transform.position += Vector3.right * (minX - corners[0].x);
            }

            // Check and adjust vertical position
            if (corners[1].y > maxY) // Top edge is off-screen
            {
                transform.position += Vector3.down * (corners[1].y - maxY);
            }
            else if (corners[3].y < minY) // Bottom edge is off-screen
            {
                transform.position += Vector3.up * (minY - corners[3].y);
            }
        }
        
        public void simulateClick(Vector2 screenPosition)
        {
            // Ensure there is an EventSystem in the scene
            if (EventSystem.current == null)
            {
                Debug.LogError("No EventSystem found in the scene. Clicks cannot be processed.");
                return;
            }

            // 1. Create a new PointerEventData
            PointerEventData pointerEventData = new PointerEventData(EventSystem.current);
            // 2. Set the position of the click
            pointerEventData.position = screenPosition;

            // 3. Raycast to find the UI element at the specified position
            List<RaycastResult> results = new List<RaycastResult>();
            EventSystem.current.RaycastAll(pointerEventData, results);

            // Find the first valid raycast target
            GameObject targetObject = null;
            if (results.Count > 0)
            {
                targetObject = results[0].gameObject;
            }
            else
            {
                return;
            }

            // 4. Set the pointerEnter, press, and potential drag targets
            pointerEventData.pointerEnter = targetObject;
            pointerEventData.pressPosition = screenPosition;
            pointerEventData.pointerPress = targetObject;
            pointerEventData.pointerDrag = targetObject;


            // 5. Dispatch the events to the target object
            // It's often best to simulate the full down->up->click sequence
            // Send PointerDown event
            ExecuteEvents.ExecuteHierarchy(targetObject, pointerEventData, ExecuteEvents.pointerDownHandler);
            // Send PointerUp event
            ExecuteEvents.ExecuteHierarchy(targetObject, pointerEventData, ExecuteEvents.pointerUpHandler);
            // Send PointerClick event
            ExecuteEvents.ExecuteHierarchy(targetObject, pointerEventData, ExecuteEvents.pointerClickHandler);
        }
    }
}