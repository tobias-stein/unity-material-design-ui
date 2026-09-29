using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Assertions;
using UnityEngine.Events;

namespace mdu.ui.demo
{
    public class NavigagtionRailDemo : MonoBehaviour
    {
        [SerializeField] private NavigationRail nav;

        public async void Start()
        {
            Assert.IsNotNull(nav, "Missing reference");

            var onClick = new UnityEvent<bool>();
            onClick.AddListener(isOpen => Snackbar.open(new SnackbarData
            {
                text = $"NavigationRail {(isOpen ? "opened" : "closed")}.",
                duration = Snackbar.Duration.Short,
            }));

            var onClick2 = new UnityEngine.UI.Button.ButtonClickedEvent();
            onClick2.AddListener(() =>
            {
                Dialog.open(new DialogData
                {
                    title = "Primary Action",
                    text = "Hello, World!",
                    persistent = true
                });
            });
            
            nav.binder.data = new NavigagtionRailData
            {
                open = false,
                showMenu = true,
                showPrimary = true,
                onMenuStateChanged = onClick,
                primaryButton = new ButtonData
                {
                    size = Button.Size.MD,
                    enabled = true,
                    icon = MaterialSymbolIcon.ICON_AIRPLANE_TICKET,
                    showIcon = true,
                    showLabel = false,
                    onClick = onClick2
                }
            };
            await nav.addMenuItem(new ListItemData
            {
                title = "First Action",
                subtitle = "Hello, earth.",
                prefix = MaterialSymbolIcon.ICON_ASPECT_RATIO,
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = new(li =>
                {
                    Dialog.open(new DialogData
                    {
                        title = li.title,
                        text = li.subtitle,
                        persistent = false
                    });
                })
            });
            await nav.addSeperator();
            await nav.addMenuItem(new ListItemData
            {
                title = "Second Action",
                subtitle = "Hello, moon.",
                prefix = MaterialSymbolIcon.ICON_12MP,
                enabled = false,
                showPrefix = true,
                showSubtitle = true,
                onClick = new(li =>
                {
                    Dialog.open(new DialogData
                    {
                        title = li.title,
                        text = li.subtitle,
                        persistent = false
                    });
                })
            });
            await nav.addSectionHeader("Sub Section");
            await nav.addMenuItem(new ListItemData
            {
                title = "Third Action",
                subtitle = "Hello, jupiter.",
                prefix = MaterialSymbolIcon.ICON_APARTMENT,
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = new(li =>
                {
                    Dialog.open(new DialogData
                    {
                        title = li.title,
                        text = li.subtitle,
                        persistent = false
                    });
                })
            });
        }
    }
}
