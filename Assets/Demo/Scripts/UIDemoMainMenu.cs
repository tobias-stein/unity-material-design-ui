using System;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Events;

namespace mdu.ui.demo
{
    [Serializable]
    public struct UIDemoMainMenuData
    {
    }

    public class UIDemoMainMenu : UIView<UIDemoMainMenu, UIDemoMainMenuData>
    {
        [SerializeField] private NavigationRail nav;

        public override void setupUI(UISettings uISettings)
        {
            #region DATA BINDING 
            #endregion // DATA BINDING
        }

        public override async UniTask show()
        {
            var onClick = new UnityEvent();
            onClick.AddListener(() =>
            {
                Snackbar.open($"It's {(!UI.settings.useDarkTheme ? "night time" : "day time")}.", Snackbar.Duration.Short, true);
                UI.settings.useDarkTheme = !UI.settings.useDarkTheme;

                var updatedPrimaryButtonData = nav.binder.data.primaryButton;
                updatedPrimaryButtonData.icon = UI.settings.useDarkTheme ? MaterialSymbolIcon.ICON_SUNNY : MaterialSymbolIcon.ICON_MOON_STARS;

                nav.binder.updateField(data => data.primaryButton, updatedPrimaryButtonData);
            });

            nav.binder.data = new NavigagtionRailData
            {
                showMenu = true,
                showPrimary = true,
                open = true,
                primaryButton = new ButtonData
                {
                    size = Button.Size.SM,
                    enabled = true,
                    showIcon = true,
                    showLabel = false,
                    icon = UI.settings.useDarkTheme ? MaterialSymbolIcon.ICON_SUNNY : MaterialSymbolIcon.ICON_MOON_STARS,
                    onClick = onClick
                }
            };

            await nav.addSectionHeader("Show a dialog");
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_CONTEXTUAL_TOKEN,
                title = "Dialog",
                subtitle = "Hello, world.",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = data => Dialog.open("My Dialog", "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book.")
            });
            await nav.addSeperator();
            await nav.addSectionHeader("Theme colors");
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_COLORIZE,
                title = "Red",
                subtitle = "Red theme",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = data => UI.settings.seedColor = Color.red
            });
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_COLORIZE,
                title = "Blue",
                subtitle = "Blue theme",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = data => UI.settings.seedColor = Color.blue
            });
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_COLORIZE,
                title = "Green",
                subtitle = "Green theme",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = data => UI.settings.seedColor = Color.green
            });
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_COLORIZE,
                title = "Magenta",
                subtitle = "Magenta theme",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = data => UI.settings.seedColor = Color.magenta
            });
            await nav.addSeperator();
            await nav.addSectionHeader("Tools");
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_COMPARE_ARROWS,
                title = "Compare",
                subtitle = "Comapre stuff",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = item =>
                {
                    item.binder.updateField(data => data.enabled, false);
                    UI.views.push<UIDemoCompareView, UIDemoCompareViewData>(
                        new UIDemoCompareViewData
                        {
                        },
                        // post construct
                        async instance =>
                        {
                            return;
                        }
                    );
                }
            });

            await nav.addSeperator();
            await nav.addMenuItem(new ListItemData
            {
                prefix = MaterialSymbolIcon.ICON_MODE_OFF_ON,
                title = "Logout",
                subtitle = "Exit application",
                enabled = true,
                showPrefix = true,
                showSubtitle = true,
                onClick = item =>
                {
#if UNITY_EDITOR
                UnityEditor.EditorApplication.isPlaying = false;
#else
                Application.Quit(0);
#endif
                }
            });

            nav.refresh();

            await base.show();
        }
    }
}
