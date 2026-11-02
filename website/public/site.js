const copyButton = document.querySelector("#copy-command");
const command = document.querySelector("#startup-command");
const status = document.querySelector("#copy-status");

if (
  copyButton &&
  command &&
  status &&
  navigator.clipboard &&
  window.isSecureContext
) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command.textContent);
      copyButton.textContent = "Copied";
      status.textContent = "Startup commands copied to clipboard.";
    } catch {
      copyButton.textContent = "Select commands to copy";
      status.textContent =
        "Clipboard access was blocked. Select the commands and copy them manually.";
    }
  });
}
