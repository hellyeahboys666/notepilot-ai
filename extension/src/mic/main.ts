import '../sidepanel/index.css';

/** One-time microphone grant for the extension, for when the side panel cannot show Chrome's prompt itself. */
const allow = document.getElementById('allow') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLParagraphElement;

allow.addEventListener('click', async () => {
  allow.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // only the permission was needed
    result.textContent = 'Done. You can close this tab and press Record in the NotePilot panel.';
  } catch (e) {
    const name = (e as { name?: string })?.name;
    result.textContent =
      name === 'NotFoundError'
        ? 'No microphone was found. Connect one and try again.'
        : 'The microphone is blocked for NotePilot. Open Chrome’s site settings for this page (the icon left of the address), allow the microphone, and try again.';
    allow.disabled = false;
  }
});
