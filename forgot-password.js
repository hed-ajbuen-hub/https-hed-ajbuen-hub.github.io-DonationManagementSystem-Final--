const recoveryForm = document.querySelector("#recovery-form");
const recoveryError = document.querySelector("#recovery-error");
const recoverySuccess = document.querySelector("#recovery-success");

recoveryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    recoveryError.textContent = "";
    recoverySuccess.textContent = "";

    const formData = new FormData(recoveryForm);
    const newPassword = String(formData.get("newPassword"));
    const confirmPassword = String(formData.get("confirmPassword"));
    if (newPassword !== confirmPassword) {
        recoveryError.textContent = "The passwords do not match.";
        return;
    }

    const submitButton = recoveryForm.querySelector("button[type='submit']");
    submitButton.disabled = true;
    try {
        const response = await window.apiRequest("/api/auth/reset-user-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                recoveryCode: formData.get("recoveryCode"),
                newPassword
            })
        });
        const responseText = await response.text();
        let result = {};
        try {
            result = responseText ? JSON.parse(responseText) : {};
        } catch {
            if (response.status === 408) {
                throw new Error("The temporary share link timed out. The site owner needs to restart the link.");
            }
            throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
        }
        if (!response.ok) {
            if (response.status === 408) {
                throw new Error("The temporary share link timed out. The site owner needs to restart the link.");
            }
            throw new Error(result.error || `Password reset failed (HTTP ${response.status}).`);
        }
        recoveryForm.reset();
        recoverySuccess.textContent = "User password reset. You can now sign in with the new password.";
    } catch (error) {
        recoveryError.textContent = error.message;
    } finally {
        submitButton.disabled = false;
    }
});