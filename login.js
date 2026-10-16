const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    const submitButton = loginForm.querySelector("button[type='submit']");
    submitButton.disabled = true;
    try {
        const response = await window.apiRequest("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(loginForm)))
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
            if (response.status === 405) {
                throw new Error("The login server is not running here. Start the app with `npm start`, then open http://localhost:3000 instead of using Live Server.");
            }
            throw new Error(result.error || `Sign in failed (HTTP ${response.status}).`);
        }
        window.location.assign("index.html");
    } catch (error) {
        loginError.textContent = error.message;
    } finally {
        submitButton.disabled = false;
    }
});