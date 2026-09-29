using UnityEngine;
using UnityEngine.Events;

namespace mdu.ui.demo
{
    public class SnackbarDemo : MonoBehaviour
    {

        [SerializeField] private Button clickMe;

        public void Awake()
        {
            var onClick = new UnityEvent();
            onClick.AddListener(showSnackbar);

            clickMe.binder.updateField(data => data.onClick, onClick);   
        }

        public void showSnackbar()
        {
            var onClick = new UnityEvent();
            onClick.AddListener(() => Dialog.open(null));
            Snackbar.open(
                new SnackbarData
                {
                    text = "Hello, Snackbar.",
                    duration = Snackbar.Duration.Long,
                    action = onClick
                }
            );
        }
    }
}
